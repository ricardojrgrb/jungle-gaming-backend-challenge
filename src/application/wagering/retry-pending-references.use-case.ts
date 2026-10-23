import { Injectable } from '@nestjs/common';
import { WagerTransactionFailed } from '../../domain/messaging/events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { newId } from '../../domain/shared/ids';
import { FailureCode } from '../../domain/wagering/failure-code';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import { ClockPort } from '../ports/clock';
import { AppLogger } from '../ports/logger';
import { Metrics } from '../ports/metrics';
import { UnitOfWork } from '../ports/repositories';
import { isTransientError } from '../shared/errors';
import { ProcessWagerTransactionUseCase } from './process-wager-transaction.use-case';

const CLAIM_BATCH = 20;
/** Tempo que uma instância "segura" uma transação reservada antes de outra poder pegá-la. */
const LEASE_MS = 60_000;

export interface RetryPendingReferencesReport {
  claimed: number;
  processed: number;
  rejected: number;
  stillPending: number;
  failed: number;
  transientErrors: number;
}

/**
 * Worker de referências fora de ordem. Funciona em duas transações por item para
 * manter a ordem de locks sempre wallet → transação (a mesma do caminho principal):
 *
 *   1. claim (curta): SKIP LOCKED + lease nas pendentes vencidas;
 *   2. por item: lock da wallet, relê a transação (FOR UPDATE), confere que ainda
 *      está PENDING_REFERENCE e roda o mesmo applyAndPersist do use case principal.
 */
@Injectable()
export class RetryPendingReferencesUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly processor: ProcessWagerTransactionUseCase,
    private readonly clock: ClockPort,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  async runOnce(): Promise<RetryPendingReferencesReport> {
    const report: RetryPendingReferencesReport = {
      claimed: 0,
      processed: 0,
      rejected: 0,
      stillPending: 0,
      failed: 0,
      transientErrors: 0,
    };

    const ids = await this.uow.run((repos) =>
      repos.transactions.claimDuePendingReferences(this.clock.now(), CLAIM_BATCH, LEASE_MS),
    );
    report.claimed = ids.length;

    for (const id of ids) {
      try {
        const status = await this.retryOne(id);
        if (status === WagerTransactionStatus.Processed) report.processed++;
        else if (status === WagerTransactionStatus.Rejected) report.rejected++;
        else if (status === WagerTransactionStatus.PendingReference) report.stillPending++;
      } catch (error) {
        if (isTransientError(error)) {
          // Lease expira e outra rodada tenta de novo.
          report.transientErrors++;
          this.metrics.pendingReferenceRetry('transient_error');
          this.logger.warn({ transactionId: id, error: (error as Error).message }, 'transient error retrying reference');
          continue;
        }
        report.failed++;
        await this.markFailed(id, error);
      }
    }
    return report;
  }

  private async retryOne(id: string): Promise<WagerTransactionStatus | null> {
    const correlationId = newId();
    return this.uow.run(
      async (repos) => {
        const probe = await repos.transactions.findById(id);
        if (!probe) return null;
        const wallet = await repos.wallets.findByIdForUpdate(probe.walletId);
        if (!wallet) return null;
        // Relê já com o lock da wallet: outra instância pode ter resolvido enquanto esperávamos.
        const tx = await repos.transactions.findByIdForUpdate(id);
        if (!tx || tx.status !== WagerTransactionStatus.PendingReference) {
          return tx?.status ?? null;
        }
        this.metrics.pendingReferenceRetry('attempt');
        const outcome = await this.processor.applyAndPersist(
          repos,
          wallet,
          tx,
          { correlationId, causationId: tx.id, source: 'scheduler' },
          this.clock.now(),
        );
        this.metrics.pendingReferenceRetry(outcome.status.toLowerCase());
        return outcome.status;
      },
      { lockTimeoutMs: 5_000 },
    );
  }

  /**
   * Erro permanente ao reprocessar: a transação vira FAILED (terminal, auditável)
   * em vez de ficar presa em PENDING_REFERENCE para sempre. Best-effort: se até
   * isso falhar, o log e o lease são o que resta.
   */
  private async markFailed(id: string, cause: unknown): Promise<void> {
    this.logger.error(
      { transactionId: id, error: cause instanceof Error ? cause.message : String(cause) },
      'permanent error while retrying pending reference',
    );
    try {
      await this.uow.run(async (repos) => {
        const tx = await repos.transactions.findByIdForUpdate(id);
        if (!tx || tx.isTerminal()) return;
        tx.fail(FailureCode.InfrastructureFailure);
        await repos.transactions.update(tx);
        await repos.outbox.enqueue([
          OutboxMessage.enqueue(
            WagerTransactionFailed.from(tx, { correlationId: newId(), causationId: tx.id }, this.clock.now()),
          ),
        ]);
        this.metrics.transactionFinished({ kind: tx.kind, status: tx.status, source: 'scheduler' });
      });
    } catch (error) {
      this.logger.error({ transactionId: id, error: (error as Error).message }, 'could not mark transaction as FAILED');
    }
  }
}
