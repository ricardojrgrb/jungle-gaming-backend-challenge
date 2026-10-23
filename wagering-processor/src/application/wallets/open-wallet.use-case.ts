import { Injectable } from '@nestjs/common';
import { WalletBalanceChanged, WalletOpened } from '../../domain/messaging/events';
import { IntegrationEvent } from '../../domain/messaging/integration-event';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money, type MoneyProps } from '../../domain/money/money';
import { newId } from '../../domain/shared/ids';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { ClockPort } from '../ports/clock';
import { AppLogger } from '../ports/logger';
import { UnitOfWork } from '../ports/repositories';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

@Injectable()
export class OpenWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: ClockPort,
    private readonly logger: AppLogger,
  ) {}

  async execute(command: OpenWalletCommand, ctx: { correlationId: string }): Promise<Wallet> {
    const initialBalance = Money.from(command.initialBalance);
    const now = this.clock.now();

    return this.uow.run(async (repos) => {
      const wallet = Wallet.open({ id: newId(), playerId: command.playerId, initialBalance, now });
      await repos.wallets.insert(wallet);

      const eventCtx = { correlationId: ctx.correlationId };
      const events: IntegrationEvent<unknown>[] = [WalletOpened.from(wallet, eventCtx)];

      if (initialBalance.isPositive()) {
        // A transação OPENING e o lançamento nascem na mesma transação SQL da wallet.
        const opening = WagerTransaction.opening({
          walletId: wallet.id,
          playerId: wallet.playerId,
          money: initialBalance,
          createdAt: now,
        });
        const entry = WalletLedgerEntry.create({
          walletId: wallet.id,
          transactionId: opening.id,
          walletVersion: wallet.version, // 1: a abertura não incrementa
          direction: LedgerDirection.Credit,
          money: initialBalance,
          balanceBefore: Money.zero(wallet.currency),
          balanceAfter: initialBalance,
          createdAt: now,
        });
        await repos.transactions.insert(opening);
        await repos.ledger.insert(entry);
        events.push(WalletBalanceChanged.from(wallet, entry, { ...eventCtx, causationId: opening.id }));
      }

      await repos.outbox.enqueue(events.map((e) => OutboxMessage.enqueue(e)));
      this.logger.info(
        { correlationId: ctx.correlationId, walletId: wallet.id, playerId: wallet.playerId, currency: wallet.currency },
        'wallet opened',
      );
      return wallet;
    });
  }
}
