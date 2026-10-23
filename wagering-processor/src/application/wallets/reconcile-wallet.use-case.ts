import { Injectable } from '@nestjs/common';
import { Money, type MoneyProps } from '../../domain/money/money';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { AppLogger } from '../ports/logger';
import { Metrics } from '../ports/metrics';
import { UnitOfWork } from '../ports/repositories';
import { WalletNotFoundError } from '../shared/errors';

export type ReconciliationIssue =
  | 'BALANCE_MISMATCH' // saldo materializado != soma do ledger
  | 'VERSION_MISMATCH' // wallet.version != versão do último lançamento
  | 'BROKEN_CHAIN' // balanceBefore de um lançamento != balanceAfter do anterior
  | 'UNBALANCED_ENTRY'; // lançamento cuja aritmética não fecha

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
  issues: ReconciliationIssue[];
}

const PAGE = 500;

/**
 * Reconstrói o saldo a partir do ledger e compara com o materializado. Roda em
 * REPEATABLE READ para enxergar um snapshot único sem segurar o lock da wallet —
 * a reconciliação não pode atrapalhar o processamento.
 *
 * Divergência não é corrigida: é logada, vira métrica e sai na resposta.
 */
@Injectable()
export class ReconcileWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  async execute(walletId: string, ctx: { correlationId: string }): Promise<ReconciliationReport> {
    const report = await this.uow.run(
      async (repos) => {
        const wallet = await repos.wallets.findById(walletId);
        if (!wallet) throw new WalletNotFoundError(walletId);

        const issues = new Set<ReconciliationIssue>();
        let running = Money.zero(wallet.currency);
        let previous: WalletLedgerEntry | null = null;
        let checked = 0;
        let afterVersion = 0;

        for (;;) {
          const page = await repos.ledger.listByWallet(walletId, afterVersion, PAGE);
          for (const entry of page.entries) {
            checked++;
            if (!entry.isBalanced()) issues.add('UNBALANCED_ENTRY');
            const expectedBefore = previous ? previous.balanceAfter : Money.zero(wallet.currency);
            if (!entry.balanceBefore.equals(expectedBefore)) issues.add('BROKEN_CHAIN');
            running =
              entry.direction === LedgerDirection.Credit ? running.add(entry.money) : running.subtract(entry.money);
            previous = entry;
          }
          if (page.lastVersion === null || page.entries.length < PAGE) break;
          afterVersion = page.lastVersion;
        }

        const difference = wallet.balance.subtract(running);
        if (!difference.isZero()) issues.add('BALANCE_MISMATCH');
        const expectedVersion = previous ? previous.walletVersion : 1;
        if (wallet.version !== expectedVersion) issues.add('VERSION_MISMATCH');

        return {
          walletId,
          storedBalance: wallet.balance.toJSON(),
          calculatedBalance: running.toJSON(),
          difference: difference.toJSON(),
          consistent: issues.size === 0,
          checkedEntries: checked,
          issues: [...issues],
        } satisfies ReconciliationReport;
      },
      { isolation: 'REPEATABLE READ' },
    );

    if (!report.consistent) {
      this.metrics.reconciliationDivergence();
      this.logger.error(
        { correlationId: ctx.correlationId, walletId, issues: report.issues, checkedEntries: report.checkedEntries },
        'wallet reconciliation divergence',
      );
    }
    return report;
  }
}
