import { InboxMessage } from '../../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../../domain/messaging/outbox-message';
import { Money } from '../../../domain/money/money';
import { FailureCode, isFailureCode } from '../../../domain/wagering/failure-code';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../../domain/wagering/wager-transaction';
import { Wallet } from '../../../domain/wallet/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry';
import { InboxMessageRecord, LedgerEntryRecord, OutboxMessageRecord, WagerTransactionRecord, WalletRecord } from '../entities/records';

// Conversão registro ↔ domínio. Sempre via `rehydrate`: o estado já foi validado
// quando entrou, não faz sentido revalidar transições ao ler.

export function walletToDomain(r: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency: r.currency,
    balance: Money.from({ amount: r.balanceAmount, currency: r.currency }),
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

export function walletToRecord(w: Wallet): WalletRecord {
  return Object.assign(new WalletRecord(), {
    id: w.id,
    playerId: w.playerId,
    currency: w.currency,
    balanceAmount: w.balance.amount,
    version: w.version,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  });
}

export function transactionToDomain(r: WagerTransactionRecord): WagerTransaction {
  const failureCode: FailureCode | undefined = isFailureCode(r.failureCode) ? r.failureCode : undefined;
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId,
    gameId: r.gameId,
    kind: r.kind as WagerTransactionKind,
    money: Money.from({ amount: r.amount, currency: r.currency }),
    referenceExternalTransactionId: r.referenceExternalTransactionId ?? undefined,
    createdAt: r.createdAt,
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: r.referenceTransactionId ?? undefined,
    failureCode,
    processedAt: r.processedAt ?? undefined,
    balanceAfter: r.balanceAfterAmount !== null ? Money.from({ amount: r.balanceAfterAmount, currency: r.currency }) : undefined,
    referenceAttempts: r.referenceAttempts,
    nextReferenceRetryAt: r.nextReferenceRetryAt ?? undefined,
  });
}

export function transactionToRecord(t: WagerTransaction, updatedAt: Date): WagerTransactionRecord {
  return Object.assign(new WagerTransactionRecord(), {
    id: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    idempotencyKey: t.idempotencyKey,
    payloadHash: t.payloadHash,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    amount: t.money.amount,
    currency: t.money.currency,
    referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
    referenceTransactionId: t.referenceTransactionId ?? null,
    status: t.status,
    failureCode: t.failureCode ?? null,
    balanceAfterAmount: t.balanceAfter?.amount ?? null,
    referenceAttempts: t.referenceAttempts,
    nextReferenceRetryAt: t.nextReferenceRetryAt ?? null,
    createdAt: t.createdAt,
    processedAt: t.processedAt ?? null,
    updatedAt,
  });
}

export function ledgerToDomain(r: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.walletId,
    transactionId: r.transactionId,
    walletVersion: r.walletVersion,
    direction: r.direction as LedgerDirection,
    money: Money.from({ amount: r.amount, currency: r.currency }),
    balanceBefore: Money.from({ amount: r.balanceBefore, currency: r.currency }),
    balanceAfter: Money.from({ amount: r.balanceAfter, currency: r.currency }),
    createdAt: r.createdAt,
  });
}

export function ledgerToRecord(e: WalletLedgerEntry): LedgerEntryRecord {
  return Object.assign(new LedgerEntryRecord(), {
    id: e.id,
    walletId: e.walletId,
    transactionId: e.transactionId,
    walletVersion: e.walletVersion,
    direction: e.direction,
    amount: e.money.amount,
    currency: e.money.currency,
    balanceBefore: e.balanceBefore.amount,
    balanceAfter: e.balanceAfter.amount,
    createdAt: e.createdAt,
  });
}

export function inboxToDomain(r: InboxMessageRecord): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: r.messageId,
    consumerName: r.consumerName,
    payloadHash: r.payloadHash,
    receivedAt: r.receivedAt,
    processedAt: r.processedAt ?? undefined,
  });
}

export function outboxToDomain(r: OutboxMessageRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: r.id,
    aggregateId: r.aggregateId,
    eventType: r.eventType,
    payload: r.payload,
    occurredAt: r.occurredAt,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt ?? undefined,
    publishedAt: r.publishedAt ?? undefined,
  });
}
