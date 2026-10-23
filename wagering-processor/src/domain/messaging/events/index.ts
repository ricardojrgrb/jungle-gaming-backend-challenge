import { type MoneyProps } from '../../money/money';
import { FailureCode } from '../../wagering/failure-code';
import { WagerTransaction, WagerTransactionKind } from '../../wagering/wager-transaction';
import { Wallet } from '../../wallet/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../wallet/wallet-ledger-entry';
import { type EventContext, IntegrationEvent } from '../integration-event';

// Todos os eventos usam walletId como aggregateId: a wallet é a unidade de
// concorrência e de ordenação, então o stream de eventos é particionado por ela
// (MessageGroupId na fila FIFO). O transactionId vai no data.

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceTransactionId?: string;
  balanceAfter: MoneyProps;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (!tx.processedAt || !tx.balanceAfter) {
      throw new Error('WagerTransactionProcessed requires a processed transaction');
    }
    return new WagerTransactionProcessed({
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: tx.processedAt,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
        balanceAfter: tx.balanceAfter.toJSON(),
        processedAt: tx.processedAt.toISOString(),
      },
    });
  }
}

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  failureCode: FailureCode;
  referenceExternalTransactionId?: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext, at: Date): WagerTransactionRejected {
    if (!tx.failureCode) {
      throw new Error('WagerTransactionRejected requires a failureCode');
    }
    return new WagerTransactionRejected({
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: at,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        failureCode: tx.failureCode,
        ...(tx.referenceExternalTransactionId
          ? { referenceExternalTransactionId: tx.referenceExternalTransactionId }
          : {}),
      },
    });
  }
}

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  referenceExternalTransactionId: string;
  walletId: string;
  kind: WagerTransactionKind;
  attempt: number;
  nextRetryAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext, at: Date): WagerTransactionPendingReference {
    if (!tx.referenceExternalTransactionId || !tx.nextReferenceRetryAt) {
      throw new Error('WagerTransactionPendingReference requires a scheduled retry');
    }
    return new WagerTransactionPendingReference({
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: at,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        walletId: tx.walletId,
        kind: tx.kind,
        attempt: tx.referenceAttempts,
        nextRetryAt: tx.nextReferenceRetryAt.toISOString(),
      },
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: entry.createdAt,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}

export interface WalletOpenedData {
  walletId: string;
  playerId: string;
  currency: string;
  initialBalance: MoneyProps;
}

export class WalletOpened extends IntegrationEvent<WalletOpenedData> {
  readonly eventType = 'WalletOpened';
  readonly version = 1;

  static from(wallet: Wallet, ctx: EventContext): WalletOpened {
    return new WalletOpened({
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: wallet.createdAt,
      data: {
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        initialBalance: wallet.balance.toJSON(),
      },
    });
  }
}

export interface WagerTransactionFailedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: WagerTransactionKind;
  failureCode: FailureCode;
}

/** Não está na lista mínima do desafio, mas FAILED é terminal e alguém precisa saber. */
export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  readonly eventType = 'WagerTransactionFailed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext, at: Date): WagerTransactionFailed {
    if (!tx.failureCode) {
      throw new Error('WagerTransactionFailed requires a failureCode');
    }
    return new WagerTransactionFailed({
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: at,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        kind: tx.kind,
        failureCode: tx.failureCode,
      },
    });
  }
}
