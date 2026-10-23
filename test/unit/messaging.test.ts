import { describe, expect, it } from 'bun:test';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../../src/domain/messaging/events';
import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { OUTBOX_RETRY_MAX_MS, OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { Money } from '../../src/domain/money/money';
import { InvariantViolationError } from '../../src/domain/shared/domain-error';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../src/domain/wallet/wallet';
import { decodeCursor, encodeCursor } from '../../src/application/wallets/wallet-queries.use-case';
import { ValidationError } from '../../src/application/shared/errors';

const now = new Date('2026-10-23T12:00:00.000Z');
const brl = (a: string) => Money.from({ amount: a, currency: 'BRL' });

describe('IntegrationEvent', () => {
  it('serializa envelope estável com eventType/version no tipo e MoneyProps no data', () => {
    const wallet = Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('100.00'), now });
    const entry = wallet.debit('tx', brl('10.00'), now);
    const event = WalletBalanceChanged.from(wallet, entry, { correlationId: 'corr', causationId: 'cause' });
    const json = event.toJSON();
    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.version).toBe(1);
    expect(json.aggregateId).toBe('w');
    expect(json.correlationId).toBe('corr');
    expect(json.causationId).toBe('cause');
    expect(json.occurredAt).toBe('2026-10-23T12:00:00.000Z');
    expect(json.data.money).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(json.data.balanceAfter).toEqual({ amount: '90.00', currency: 'BRL' });
    expect(json.data.walletVersion).toBe(2);
    expect(typeof json.eventId).toBe('string');
    // JSON.stringify não vaza instâncias de Money nem Date
    expect(JSON.parse(JSON.stringify(event))).toEqual(JSON.parse(JSON.stringify(json)));
  });

  it('WagerTransactionProcessed exige transação processada', () => {
    const tx = WagerTransaction.create({
      providerId: 'p', externalTransactionId: 'e', idempotencyKey: 'k', payloadHash: 'h', walletId: 'w', playerId: 'pl', roundId: 'r', gameId: 'g',
      kind: WagerTransactionKind.Bet, money: brl('1.00'), createdAt: now,
    });
    expect(() => WagerTransactionProcessed.from(tx, { correlationId: 'c' })).toThrow();
    tx.markProcessed(undefined, now, brl('9.00'));
    expect(WagerTransactionProcessed.from(tx, { correlationId: 'c' }).data.balanceAfter).toEqual({ amount: '9.00', currency: 'BRL' });
  });
});

describe('OutboxMessage', () => {
  function outbox() {
    const wallet = Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00'), now });
    const entry = wallet.credit('tx', brl('1.00'), now);
    return OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, { correlationId: 'c' }));
  }

  it('enqueue copia o envelope e usa o eventId como id', () => {
    const m = outbox();
    expect(m.id).toBe((m.payload as { eventId: string }).eventId);
    expect(m.eventType).toBe('WalletBalanceChanged');
    expect(m.isPending()).toBe(true);
    expect(m.isDue(now)).toBe(true);
    expect(m.attempts).toBe(0);
  });

  it('scheduleRetry faz backoff exponencial com teto e nunca desiste', () => {
    const m = outbox();
    m.scheduleRetry(now);
    expect(m.attempts).toBe(1);
    expect(m.nextAttemptAt?.getTime()).toBe(now.getTime() + 1000);
    expect(m.isDue(now)).toBe(false);
    expect(m.isDue(new Date(now.getTime() + 1000))).toBe(true);
    for (let i = 0; i < 20; i++) m.scheduleRetry(now);
    expect(m.nextAttemptAt?.getTime()).toBe(now.getTime() + OUTBOX_RETRY_MAX_MS);
    expect(m.isPending()).toBe(true);
  });

  it('markPublished é terminal', () => {
    const m = outbox();
    m.markPublished(now);
    expect(m.isPending()).toBe(false);
    expect(m.isDue(now)).toBe(false);
    expect(() => m.markPublished(now)).toThrow(InvariantViolationError);
    expect(() => m.scheduleRetry(now)).toThrow(InvariantViolationError);
  });
});

describe('InboxMessage', () => {
  it('receive → markProcessed uma única vez', () => {
    const m = InboxMessage.receive({ messageId: 'm', consumerName: 'c', payloadHash: 'h', receivedAt: now });
    expect(m.isProcessed()).toBe(false);
    m.markProcessed(now);
    expect(m.isProcessed()).toBe(true);
    expect(() => m.markProcessed(now)).toThrow(InvariantViolationError);
  });
});

describe('ledger cursor', () => {
  it('é opaco, estável e reversível', () => {
    const c = encodeCursor(42);
    expect(c).not.toContain('42');
    expect(decodeCursor(c)).toBe(42);
    expect(decodeCursor(undefined)).toBe(0);
  });
  it('rejeita cursor adulterado', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow(ValidationError);
    expect(() => decodeCursor(Buffer.from('{"v":-1}').toString('base64url'))).toThrow(ValidationError);
    expect(() => decodeCursor(Buffer.from('{"v":"1"}').toString('base64url'))).toThrow(ValidationError);
  });
});
