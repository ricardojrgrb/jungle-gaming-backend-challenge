import { describe, expect, it } from 'bun:test';
import { Money } from '../../src/domain/money/money';
import { InvariantViolationError } from '../../src/domain/shared/domain-error';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { DEFAULT_REFERENCE_RETRY_POLICY, referenceRetryDelayMs } from '../../src/domain/wagering/reference-retry-policy';
import {
  InvalidTransactionStateError,
  ReferenceRequiredError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wagering/wager-transaction';
import { LedgerDirection } from '../../src/domain/wallet/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-10-23T12:00:00Z');

function make(kind: WagerTransactionKind, extra: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) {
  return WagerTransaction.create({
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'h'.repeat(64),
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'r1',
    gameId: 'g1',
    kind,
    money: brl('10.00'),
    createdAt: now,
    ...extra,
  });
}

describe('WagerTransaction', () => {
  it('nasce PENDING', () => {
    const tx = make(WagerTransactionKind.Bet);
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.referenceAttempts).toBe(0);
  });

  it('REFUND e ROLLBACK exigem referência', () => {
    expect(() => make(WagerTransactionKind.Refund)).toThrow(ReferenceRequiredError);
    expect(() => make(WagerTransactionKind.Rollback)).toThrow(ReferenceRequiredError);
    expect(make(WagerTransactionKind.Refund, { referenceExternalTransactionId: 'ext-0' }).requiresReference()).toBe(true);
    expect(make(WagerTransactionKind.Win).requiresReference()).toBe(false);
  });

  it('OPENING não pode ser criado pela factory pública', () => {
    expect(() => make(WagerTransactionKind.Opening)).toThrow(InvariantViolationError);
    const opening = WagerTransaction.opening({ walletId: 'w', playerId: 'p', money: brl('5.00'), createdAt: now });
    expect(opening.kind).toBe(WagerTransactionKind.Opening);
    expect(opening.status).toBe(WagerTransactionStatus.Processed);
  });

  it('valor precisa ser positivo', () => {
    expect(() => make(WagerTransactionKind.Bet, { money: brl('0.00') })).toThrow(InvariantViolationError);
  });

  it('LOSS não afeta saldo; os outros afetam', () => {
    expect(make(WagerTransactionKind.Loss).affectsBalance()).toBe(false);
    expect(make(WagerTransactionKind.Bet).affectsBalance()).toBe(true);
    expect(make(WagerTransactionKind.Win).affectsBalance()).toBe(true);
  });

  it('direção do lançamento por kind', () => {
    expect(make(WagerTransactionKind.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(make(WagerTransactionKind.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(make(WagerTransactionKind.Refund, { referenceExternalTransactionId: 'x' }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(() => make(WagerTransactionKind.Loss).ledgerDirectionFor()).toThrow(InvariantViolationError);
  });

  it('ROLLBACK inverte a direção da referência', () => {
    const rollback = make(WagerTransactionKind.Rollback, { referenceExternalTransactionId: 'x' });
    expect(rollback.ledgerDirectionFor(make(WagerTransactionKind.Bet))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(make(WagerTransactionKind.Win))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(make(WagerTransactionKind.Refund, { referenceExternalTransactionId: 'y' }))).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvariantViolationError);
  });

  it('transições: PENDING → PROCESSED é terminal', () => {
    const tx = make(WagerTransactionKind.Bet);
    tx.markProcessed(undefined, now, brl('90.00'));
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.processedAt).toEqual(now);
    expect(tx.balanceAfter?.amount).toBe('90.00');
    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.reject(FailureCode.InsufficientFunds, brl('0.00'))).toThrow(InvalidTransactionStateError);
    expect(() => tx.markProcessed(undefined, now, brl('1.00'))).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.InfrastructureFailure)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference(now, DEFAULT_REFERENCE_RETRY_POLICY, brl('1.00'))).toThrow(InvalidTransactionStateError);
  });

  it('transições: REJECTED e FAILED são terminais e carregam failureCode', () => {
    const rejected = make(WagerTransactionKind.Bet);
    rejected.reject(FailureCode.InsufficientFunds, brl('5.00'));
    expect(rejected.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(rejected.balanceAfter?.amount).toBe('5.00');
    expect(rejected.processedAt).toBeUndefined();
    expect(() => rejected.markProcessed(undefined, now, brl('1.00'))).toThrow(InvalidTransactionStateError);

    const failed = make(WagerTransactionKind.Bet);
    failed.fail(FailureCode.InfrastructureFailure);
    expect(failed.status).toBe(WagerTransactionStatus.Failed);
    expect(failed.isTerminal()).toBe(true);
  });

  it('PENDING_REFERENCE agenda retries com backoff exponencial e pode ser resolvida depois', () => {
    const policy = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 3000 };
    const tx = make(WagerTransactionKind.Refund, { referenceExternalTransactionId: 'bet' });
    tx.markPendingReference(now, policy, brl('100.00'));
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.referenceAttempts).toBe(1);
    expect(tx.nextReferenceRetryAt?.getTime()).toBe(now.getTime() + 1000);
    tx.markPendingReference(now, policy, brl('100.00'));
    expect(tx.referenceAttempts).toBe(2);
    expect(tx.nextReferenceRetryAt?.getTime()).toBe(now.getTime() + 2000);
    tx.markPendingReference(now, policy, brl('100.00'));
    expect(tx.nextReferenceRetryAt?.getTime()).toBe(now.getTime() + 3000); // cap
    expect(tx.hasExhaustedReferenceRetries(policy)).toBe(true);
    tx.markProcessed('ref-id', now, brl('110.00'));
    expect(tx.referenceTransactionId).toBe('ref-id');
    expect(tx.nextReferenceRetryAt).toBeUndefined();
  });

  it('política default: 8 tentativas, 5s..300s', () => {
    expect(DEFAULT_REFERENCE_RETRY_POLICY.maxAttempts).toBe(8);
    expect(referenceRetryDelayMs(DEFAULT_REFERENCE_RETRY_POLICY, 1)).toBe(5_000);
    expect(referenceRetryDelayMs(DEFAULT_REFERENCE_RETRY_POLICY, 6)).toBe(160_000);
    expect(referenceRetryDelayMs(DEFAULT_REFERENCE_RETRY_POLICY, 7)).toBe(300_000);
    expect(referenceRetryDelayMs(DEFAULT_REFERENCE_RETRY_POLICY, 8)).toBe(300_000);
  });

  it('matchesPayload compara o hash', () => {
    const tx = make(WagerTransactionKind.Bet);
    expect(tx.matchesPayload('h'.repeat(64))).toBe(true);
    expect(tx.matchesPayload('x'.repeat(64))).toBe(false);
  });

  it('rehydrate aceita qualquer estado persistido sem revalidar', () => {
    const tx = WagerTransaction.rehydrate({
      id: 'id',
      providerId: 'p',
      externalTransactionId: 'e',
      idempotencyKey: 'k',
      payloadHash: 'h',
      walletId: 'w',
      playerId: 'pl',
      roundId: 'r',
      gameId: 'g',
      kind: WagerTransactionKind.Refund,
      money: brl('1.00'),
      referenceExternalTransactionId: undefined, // inválido para create, mas rehydrate não liga
      createdAt: now,
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceNotFound,
      referenceAttempts: 8,
    });
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.isTerminal()).toBe(true);
  });
});
