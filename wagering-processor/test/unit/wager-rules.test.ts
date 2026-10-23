import { describe, expect, it } from 'bun:test';
import { referenceStillPending, validateReference } from '../../src/application/wagering/wager-rules';
import { Money } from '../../src/domain/money/money';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction';

const now = new Date();
function tx(kind: WagerTransactionKind, overrides: Partial<{ playerId: string; walletId: string; roundId: string; amount: string; currency: string; ref: string }> = {}) {
  const t = WagerTransaction.create({
    providerId: 'p',
    externalTransactionId: `ext-${kind}-${Math.random()}`,
    idempotencyKey: `k-${Math.random()}`,
    payloadHash: 'h',
    walletId: overrides.walletId ?? 'w',
    playerId: overrides.playerId ?? 'pl',
    roundId: overrides.roundId ?? 'r',
    gameId: 'g',
    kind,
    money: Money.from({ amount: overrides.amount ?? '10.00', currency: overrides.currency ?? 'BRL' }),
    referenceExternalTransactionId: overrides.ref ?? (kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback ? 'ref' : undefined),
    createdAt: now,
  });
  return t;
}
function processed(kind: WagerTransactionKind, overrides = {}) {
  const t = tx(kind, overrides);
  t.markProcessed(undefined, now, Money.zero('BRL'));
  return t;
}

describe('validateReference', () => {
  it('REFUND só referencia BET', () => {
    expect(validateReference(tx(WagerTransactionKind.Refund), processed(WagerTransactionKind.Bet))).toBeNull();
    expect(validateReference(tx(WagerTransactionKind.Refund), processed(WagerTransactionKind.Win))).toBe(FailureCode.ReferenceKindNotAllowed);
    expect(validateReference(tx(WagerTransactionKind.Refund), processed(WagerTransactionKind.Refund))).toBe(FailureCode.ReferenceKindNotAllowed);
  });

  it('ROLLBACK referencia BET, WIN ou REFUND, nunca LOSS ou ROLLBACK', () => {
    expect(validateReference(tx(WagerTransactionKind.Rollback), processed(WagerTransactionKind.Bet))).toBeNull();
    expect(validateReference(tx(WagerTransactionKind.Rollback), processed(WagerTransactionKind.Win))).toBeNull();
    expect(validateReference(tx(WagerTransactionKind.Rollback), processed(WagerTransactionKind.Refund))).toBeNull();
    expect(validateReference(tx(WagerTransactionKind.Rollback), processed(WagerTransactionKind.Loss))).toBe(FailureCode.ReferenceKindNotAllowed);
    expect(validateReference(tx(WagerTransactionKind.Rollback), processed(WagerTransactionKind.Rollback))).toBe(FailureCode.ReferenceKindNotAllowed);
  });

  it('WIN/LOSS com referência: precisa ser a BET da rodada', () => {
    expect(validateReference(tx(WagerTransactionKind.Win, { ref: 'bet' }), processed(WagerTransactionKind.Bet))).toBeNull();
    expect(validateReference(tx(WagerTransactionKind.Win, { ref: 'bet' }), processed(WagerTransactionKind.Win))).toBe(FailureCode.ReferenceKindNotAllowed);
  });

  it('referência de outro player, wallet, rodada ou moeda é mismatch', () => {
    expect(validateReference(tx(WagerTransactionKind.Refund), processed(WagerTransactionKind.Bet, { playerId: 'other' }))).toBe(FailureCode.ReferenceMismatch);
    expect(validateReference(tx(WagerTransactionKind.Refund), processed(WagerTransactionKind.Bet, { walletId: 'other' }))).toBe(FailureCode.ReferenceMismatch);
    expect(validateReference(tx(WagerTransactionKind.Refund), processed(WagerTransactionKind.Bet, { roundId: 'other' }))).toBe(FailureCode.ReferenceMismatch);
    expect(validateReference(tx(WagerTransactionKind.Refund, { currency: 'USD' }), processed(WagerTransactionKind.Bet))).toBe(FailureCode.ReferenceMismatch);
  });

  it('referência REJECTED/FAILED não pode ser revertida', () => {
    const rejected = tx(WagerTransactionKind.Bet);
    rejected.reject(FailureCode.InsufficientFunds, Money.zero('BRL'));
    expect(validateReference(tx(WagerTransactionKind.Refund), rejected)).toBe(FailureCode.ReferenceNotProcessed);
  });

  it('reversão parcial está fora de escopo: valor tem que ser igual', () => {
    expect(validateReference(tx(WagerTransactionKind.Refund, { amount: '9.99' }), processed(WagerTransactionKind.Bet))).toBe(FailureCode.ReferenceAmountMismatch);
    // WIN referenciando BET pode ter valor diferente (não é reversão)
    expect(validateReference(tx(WagerTransactionKind.Win, { ref: 'bet', amount: '50.00' }), processed(WagerTransactionKind.Bet))).toBeNull();
  });

  it('referenceStillPending: ausente ou ainda não resolvida → vale esperar', () => {
    expect(referenceStillPending(null)).toBe(true);
    expect(referenceStillPending(tx(WagerTransactionKind.Bet))).toBe(true);
    const pending = tx(WagerTransactionKind.Refund);
    pending.markPendingReference(now, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 }, Money.zero('BRL'));
    expect(referenceStillPending(pending)).toBe(true);
    expect(referenceStillPending(processed(WagerTransactionKind.Bet))).toBe(false);
    const rejected = tx(WagerTransactionKind.Bet);
    rejected.reject(FailureCode.InsufficientFunds, Money.zero('BRL'));
    expect(referenceStillPending(rejected)).toBe(false);
  });
});
