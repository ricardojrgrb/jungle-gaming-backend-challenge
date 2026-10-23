import { Injectable } from '@nestjs/common';
import { IntegrationEvent } from '../../domain/messaging/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/messaging/events';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/money/money';
import { FailureCode } from '../../domain/wagering/failure-code';
import { WagerTransaction, WagerTransactionKind } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { LedgerDirection } from '../../domain/wallet/wallet-ledger-entry';
import { ClockPort, ReferenceRetryPolicyPort } from '../ports/clock';
import { AppLogger } from '../ports/logger';
import { Metrics } from '../ports/metrics';
import { type Repositories, UnitOfWork } from '../ports/repositories';
import { IdempotencyConflictError, WalletNotFoundError, WalletVersionConflictError } from '../shared/errors';
import { withRetry } from '../shared/retry';
import { hashWagerPayload } from './payload-hash';
import { type ProcessingContext, type SubmitWagerTransactionCommand } from './submit-wager-transaction.command';
import { type WagerOutcome, outcomeFrom } from './wager-outcome';
import { referenceStillPending, validateReference } from './wager-rules';

export type ProcessResult =
  | { type: 'outcome'; outcome: WagerOutcome }
  /** A inbox já tinha (consumerName, messageId): efeito já aplicado, só dar ack. */
  | { type: 'duplicate_message' };

/** Quantas vezes tentar de novo em conflito de lock/versão antes de devolver 503/retry SQS. */
const LOCK_RETRY_ATTEMPTS = 3;
const LOCK_TIMEOUT_MS = 5_000;

/**
 * O único caminho que aplica uma operação de aposta. HTTP, SQS e o worker de
 * referências pendentes chegam aqui.
 *
 * Ordem dentro da transação SQL:
 *   1. inbox (se veio da fila) — ON CONFLICT DO NOTHING; duplicata sai aqui;
 *   2. SELECT ... FOR UPDATE na wallet — tudo da mesma wallet fica em fila;
 *   3. re-checagem de idempotência já com o lock (a primeira, fora da transação,
 *      é só atalho para replays não disputarem o lock);
 *   4. regras de negócio → PROCESSED / REJECTED / PENDING_REFERENCE;
 *   5. ledger + UPDATE condicionado da wallet + outbox;
 *   6. commit. O ack do SQS e a resposta HTTP só acontecem depois daqui.
 */
@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: ClockPort,
    private readonly retryPolicyPort: ReferenceRetryPolicyPort,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  private get retryPolicy() {
    return this.retryPolicyPort.policy;
  }

  async execute(command: SubmitWagerTransactionCommand, ctx: ProcessingContext): Promise<ProcessResult> {
    const startedAt = performance.now();
    const payloadHash = hashWagerPayload(command);
    const log = this.logger.child({
      correlationId: ctx.correlationId,
      walletId: command.walletId,
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      source: ctx.source,
    });

    // Atalho: replay conhecido não precisa disputar o lock da wallet.
    const known = await this.uow.read((repos) => repos.transactions.findByIdempotencyKey(command.idempotencyKey));
    if (known) {
      const outcome = this.replayOrConflict(known, payloadHash, command, ctx);
      // Se veio da fila, ainda registramos a inbox para o redelivery ser barato.
      if (ctx.inbox) {
        await this.recordInboxForReplay(ctx);
      }
      log.info({ transactionId: known.id, status: known.status }, 'idempotent replay');
      return { type: 'outcome', outcome };
    }

    try {
      return await withRetry(
        () =>
          this.uow.run(
            async (repos) => {
              let inbox: InboxMessage | undefined;
              if (ctx.inbox) {
                inbox = InboxMessage.receive({ ...ctx.inbox, receivedAt: this.clock.now() });
                const fresh = await repos.inbox.tryInsert(inbox);
                if (!fresh) {
                  this.metrics.inboxDuplicate();
                  log.info({ messageId: ctx.inbox.messageId }, 'duplicate message (inbox)');
                  return { type: 'duplicate_message' } as const;
                }
              }

              const lockStart = performance.now();
              const wallet = await repos.wallets.findByIdForUpdate(command.walletId);
              this.metrics.lockWait((performance.now() - lockStart) / 1000);
              if (!wallet) {
                throw new WalletNotFoundError(command.walletId);
              }

              // Agora com o lock: quem chegou antes já commitou e aparece aqui.
              const existing = await repos.transactions.findByIdempotencyKey(command.idempotencyKey);
              if (existing) {
                const outcome = this.replayOrConflict(existing, payloadHash, command, ctx);
                if (inbox) {
                  inbox.markProcessed(this.clock.now());
                  await repos.inbox.update(inbox);
                }
                return { type: 'outcome', outcome } as const;
              }
              const sameExternalId = await repos.transactions.findByProviderAndExternalId(
                command.providerId,
                command.externalTransactionId,
              );
              if (sameExternalId) {
                throw new IdempotencyConflictError({
                  reason: 'externalTransactionId already used with another idempotency key',
                  providerId: command.providerId,
                  externalTransactionId: command.externalTransactionId,
                  existingTransactionId: sameExternalId.id,
                });
              }

              const now = this.clock.now();
              const tx = WagerTransaction.create({
                providerId: command.providerId,
                externalTransactionId: command.externalTransactionId,
                idempotencyKey: command.idempotencyKey,
                payloadHash,
                walletId: command.walletId,
                playerId: command.playerId,
                roundId: command.roundId,
                gameId: command.gameId,
                kind: command.kind,
                money: Money.from(command.money),
                referenceExternalTransactionId: command.referenceExternalTransactionId,
                createdAt: now,
              });
              await repos.transactions.insert(tx);

              const outcome = await this.applyAndPersist(repos, wallet, tx, ctx, now);
              if (inbox) {
                inbox.markProcessed(this.clock.now());
                await repos.inbox.update(inbox);
              }
              return { type: 'outcome', outcome } as const;
            },
            { lockTimeoutMs: LOCK_TIMEOUT_MS },
          ),
        {
          attempts: LOCK_RETRY_ATTEMPTS,
          baseDelayMs: 20,
          shouldRetry: (e) => e instanceof WalletVersionConflictError,
          onRetry: (e, attempt) => {
            this.metrics.lockConflict('version');
            log.warn({ attempt, error: (e as Error).message }, 'wallet version conflict, retrying');
          },
        },
      );
    } finally {
      this.metrics.processingDuration(
        { source: ctx.source, kind: command.kind },
        (performance.now() - startedAt) / 1000,
      );
    }
  }

  /**
   * Núcleo compartilhado com o worker de referências pendentes. Pressupõe que o
   * chamador segura o lock da wallet e que `tx` já está persistida.
   */
  async applyAndPersist(
    repos: Repositories,
    wallet: Wallet,
    tx: WagerTransaction,
    ctx: ProcessingContext,
    now: Date,
  ): Promise<WagerOutcome> {
    const events: IntegrationEvent<unknown>[] = [];
    const eventCtx = { correlationId: ctx.correlationId, causationId: ctx.causationId ?? tx.id };
    const log = this.logger.child({
      correlationId: ctx.correlationId,
      transactionId: tx.id,
      walletId: wallet.id,
      providerId: tx.providerId,
      kind: tx.kind,
    });

    const reject = async (code: FailureCode): Promise<WagerOutcome> => {
      tx.reject(code, wallet.balance);
      await repos.transactions.update(tx);
      events.push(WagerTransactionRejected.from(tx, eventCtx, now));
      await repos.outbox.enqueue(events.map((e) => OutboxMessage.enqueue(e)));
      // Rejeitada também é desfecho: quem esperava por esta transação pode parar
      // de esperar (vai cair em REFERENCE_NOT_PROCESSED em vez de esperar o backoff).
      await this.wakeUpWaiters(repos, tx, now, log);
      this.metrics.transactionFinished({ kind: tx.kind, status: tx.status, source: ctx.source });
      log.info({ status: tx.status, failureCode: code }, 'transaction rejected');
      return outcomeFrom(tx, false);
    };

    if (!wallet.acceptsCurrency(tx.money.currency)) {
      return reject(FailureCode.CurrencyMismatch);
    }
    if (wallet.playerId !== tx.playerId) {
      return reject(FailureCode.PlayerWalletMismatch);
    }

    let reference: WagerTransaction | undefined;
    if (tx.referenceExternalTransactionId) {
      const found = await repos.transactions.findByProviderAndExternalId(
        tx.providerId,
        tx.referenceExternalTransactionId,
      );
      if (referenceStillPending(found)) {
        if (tx.hasExhaustedReferenceRetries(this.retryPolicy)) {
          this.metrics.pendingReferenceRetry('exhausted');
          return reject(FailureCode.ReferenceNotFound);
        }
        tx.markPendingReference(now, this.retryPolicy, wallet.balance);
        await repos.transactions.update(tx);
        events.push(WagerTransactionPendingReference.from(tx, eventCtx, now));
        await repos.outbox.enqueue(events.map((e) => OutboxMessage.enqueue(e)));
        this.metrics.transactionFinished({ kind: tx.kind, status: tx.status, source: ctx.source });
        log.info(
          { attempt: tx.referenceAttempts, nextRetryAt: tx.nextReferenceRetryAt },
          'reference not found yet, scheduled retry',
        );
        return outcomeFrom(tx, false);
      }
      reference = found as WagerTransaction;
      const violation = validateReference(tx, reference);
      if (violation) {
        return reject(violation);
      }
      if (tx.isReversal() && (await repos.transactions.hasProcessedReversalOf(reference.id))) {
        return reject(FailureCode.ReferenceAlreadyReversed);
      }
    }

    if (tx.affectsBalance()) {
      const direction = tx.ledgerDirectionFor(reference);
      if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
        return reject(
          tx.kind === WagerTransactionKind.Bet
            ? FailureCode.InsufficientFunds
            : FailureCode.ReversalInsufficientFunds,
        );
      }
      const versionBefore = wallet.version;
      const entry =
        direction === LedgerDirection.Debit
          ? wallet.debit(tx.id, tx.money, now)
          : wallet.credit(tx.id, tx.money, now);
      tx.markProcessed(reference?.id, now, wallet.balance);

      await repos.ledger.insert(entry);
      await repos.wallets.update(wallet, versionBefore);
      events.push(WalletBalanceChanged.from(wallet, entry, eventCtx));
    } else {
      // LOSS: registra o resultado, saldo e ledger ficam como estão.
      tx.markProcessed(reference?.id, now, wallet.balance);
    }

    await repos.transactions.update(tx);
    events.push(WagerTransactionProcessed.from(tx, eventCtx));
    await repos.outbox.enqueue(events.map((e) => OutboxMessage.enqueue(e)));

    // Alguém pode estar esperando por esta transação (REFUND que chegou antes da BET).
    await this.wakeUpWaiters(repos, tx, now, log);

    this.metrics.transactionFinished({ kind: tx.kind, status: tx.status, source: ctx.source });
    log.info({ status: tx.status, walletVersion: wallet.version }, 'transaction processed');
    return outcomeFrom(tx, false);
  }

  private async wakeUpWaiters(repos: Repositories, tx: WagerTransaction, now: Date, log: AppLogger): Promise<void> {
    const woken = await repos.transactions.wakeUpWaitingReferences(tx.providerId, tx.externalTransactionId, now);
    if (woken > 0) {
      log.info({ woken }, 'woke up transactions waiting for this reference');
    }
  }

  private replayOrConflict(
    existing: WagerTransaction,
    payloadHash: string,
    command: SubmitWagerTransactionCommand,
    ctx: ProcessingContext,
  ): WagerOutcome {
    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError({
        idempotencyKey: command.idempotencyKey,
        existingTransactionId: existing.id,
      });
    }
    this.metrics.idempotentReplay(ctx.source);
    return outcomeFrom(existing, true);
  }

  private async recordInboxForReplay(ctx: ProcessingContext): Promise<void> {
    const inbox = ctx.inbox;
    if (!inbox) return;
    await this.uow.run(async (repos) => {
      const message = InboxMessage.receive({ ...inbox, receivedAt: this.clock.now() });
      const fresh = await repos.inbox.tryInsert(message);
      if (!fresh) {
        this.metrics.inboxDuplicate();
        return;
      }
      message.markProcessed(this.clock.now());
      await repos.inbox.update(message);
    });
  }
}
