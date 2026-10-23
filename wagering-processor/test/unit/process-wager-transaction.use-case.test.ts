import { beforeEach, describe, expect, it } from 'bun:test';
import { NoopLogger } from '../../src/application/ports/logger';
import { NoopMetrics } from '../../src/application/ports/metrics';
import { IdempotencyConflictError, WalletNotFoundError } from '../../src/application/shared/errors';
import { ProcessWagerTransactionUseCase } from '../../src/application/wagering/process-wager-transaction.use-case';
import { RetryPendingReferencesUseCase } from '../../src/application/wagering/retry-pending-references.use-case';
import type { SubmittableKind, SubmitWagerTransactionCommand } from '../../src/application/wagering/submit-wager-transaction.command';
import type { WagerOutcome } from '../../src/application/wagering/wager-outcome';
import { OpenWalletUseCase } from '../../src/application/wallets/open-wallet.use-case';
import { Money } from '../../src/domain/money/money';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction';
import { InMemoryUnitOfWork } from '../helpers/in-memory-uow';

class FakeClock {
  current = new Date('2026-10-23T12:00:00Z');
  now() {
    return new Date(this.current);
  }
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
}

const policy = { policy: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 4000 } };

describe('ProcessWagerTransactionUseCase (regras, em memória)', () => {
  let uow: InMemoryUnitOfWork;
  let clock: FakeClock;
  let useCase: ProcessWagerTransactionUseCase;
  let retry: RetryPendingReferencesUseCase;
  let walletId: string;
  const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
  const ctx = { correlationId: 'corr', source: 'http' as const };

  const cmd = (overrides: Partial<Omit<SubmitWagerTransactionCommand, 'kind'>> & { externalTransactionId: string; kind?: string }): SubmitWagerTransactionCommand => ({
    providerId: 'provider-a',
    idempotencyKey: `provider-a:${overrides.externalTransactionId}`,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'game',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
    kind: (overrides.kind ?? 'BET') as SubmittableKind,
  });

  async function run(c: SubmitWagerTransactionCommand): Promise<WagerOutcome> {
    const r = await useCase.execute(c, ctx);
    if (r.type !== 'outcome') throw new Error('unexpected duplicate');
    return r.outcome;
  }

  function ledgerOf(id = walletId) {
    return uow.ledger.filter((e) => e.walletId === id);
  }

  beforeEach(async () => {
    uow = new InMemoryUnitOfWork();
    clock = new FakeClock();
    const logger = new NoopLogger();
    const metrics = new NoopMetrics();
    useCase = new ProcessWagerTransactionUseCase(uow, clock, policy, metrics, logger);
    retry = new RetryPendingReferencesUseCase(uow, useCase, clock, metrics, logger);
    const wallet = await new OpenWalletUseCase(uow, clock, logger).execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }, ctx);
    walletId = wallet.id;
  });

  it('abertura: OPENING + lançamento CREDIT, version 1, eventos WalletOpened e WalletBalanceChanged', () => {
    expect(uow.wallets.get(walletId)!.version).toBe(1);
    expect(ledgerOf()).toHaveLength(1);
    expect(ledgerOf()[0]!.walletVersion).toBe(1);
    expect(uow.outbox.map((m) => m.eventType)).toEqual(['WalletOpened', 'WalletBalanceChanged']);
  });

  it('abrir com saldo zero não gera OPENING nem lançamento', async () => {
    const w = await new OpenWalletUseCase(uow, clock, new NoopLogger()).execute({ playerId: crypto.randomUUID(), initialBalance: { amount: '0.00', currency: 'BRL' } }, ctx);
    expect(ledgerOf(w.id)).toHaveLength(0);
    expect(w.version).toBe(1);
  });

  it('BET debita, gera DEBIT, incrementa version e publica Processed + BalanceChanged', async () => {
    const out = await run(cmd({ externalTransactionId: 'bet-1' }));
    expect(out.status).toBe(WagerTransactionStatus.Processed);
    expect(out.balance.amount).toBe('75.00');
    expect(out.idempotentReplay).toBe(false);
    expect(uow.wallets.get(walletId)!.version).toBe(2);
    expect(ledgerOf()).toHaveLength(2);
    expect(uow.outbox.slice(2).map((m) => m.eventType).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  it('BET sem saldo → REJECTED INSUFFICIENT_FUNDS, sem ledger, evento Rejected', async () => {
    const out = await run(cmd({ externalTransactionId: 'big', money: { amount: '100.01', currency: 'BRL' } }));
    expect(out.status).toBe(WagerTransactionStatus.Rejected);
    expect(out.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(out.balance.amount).toBe('100.00');
    expect(ledgerOf()).toHaveLength(1);
    expect(uow.wallets.get(walletId)!.version).toBe(1);
    expect(uow.outbox.at(-1)!.eventType).toBe('WagerTransactionRejected');
  });

  it('WIN credita; LOSS registra sem mexer no saldo nem no ledger', async () => {
    await run(cmd({ externalTransactionId: 'bet-1' }));
    const win = await run(cmd({ externalTransactionId: 'win-1', kind: 'WIN', money: { amount: '50.00', currency: 'BRL' } }));
    expect(win.balance.amount).toBe('125.00');
    const versionBefore = uow.wallets.get(walletId)!.version;
    const outboxBefore = uow.outbox.length;
    const loss = await run(cmd({ externalTransactionId: 'loss-1', kind: 'LOSS', money: { amount: '25.00', currency: 'BRL' }, roundId: 'round-2' }));
    expect(loss.status).toBe(WagerTransactionStatus.Processed);
    expect(loss.balance.amount).toBe('125.00');
    expect(uow.wallets.get(walletId)!.version).toBe(versionBefore);
    expect(ledgerOf()).toHaveLength(3);
    expect(uow.outbox.slice(outboxBefore).map((m) => m.eventType)).toEqual(['WagerTransactionProcessed']); // sem WalletBalanceChanged
  });

  it('WIN com referência à BET da rodada', async () => {
    await run(cmd({ externalTransactionId: 'bet-1' }));
    const win = await run(cmd({ externalTransactionId: 'win-1', kind: 'WIN', referenceExternalTransactionId: 'bet-1' }));
    expect(win.status).toBe(WagerTransactionStatus.Processed);
    const other = await run(cmd({ externalTransactionId: 'win-2', kind: 'WIN', referenceExternalTransactionId: 'bet-1', roundId: 'round-9' }));
    expect(other.failureCode).toBe(FailureCode.ReferenceMismatch);
  });

  it('REFUND reverte BET uma única vez', async () => {
    await run(cmd({ externalTransactionId: 'bet-1' }));
    const refund = await run(cmd({ externalTransactionId: 'ref-1', kind: 'REFUND', referenceExternalTransactionId: 'bet-1' }));
    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.balance.amount).toBe('100.00');
    const again = await run(cmd({ externalTransactionId: 'ref-2', kind: 'REFUND', referenceExternalTransactionId: 'bet-1' }));
    expect(again.status).toBe(WagerTransactionStatus.Rejected);
    expect(again.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    // ROLLBACK da mesma BET depois do REFUND também é bloqueado (senão credita duas vezes)
    const rb = await run(cmd({ externalTransactionId: 'rb-1', kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1' }));
    expect(rb.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(uow.wallets.get(walletId)!.balance.amount).toBe('100.00');
  });

  it('REFUND só de BET, com valor igual, da mesma rodada/player', async () => {
    await run(cmd({ externalTransactionId: 'bet-1' }));
    await run(cmd({ externalTransactionId: 'win-1', kind: 'WIN' }));
    expect((await run(cmd({ externalTransactionId: 'r1', kind: 'REFUND', referenceExternalTransactionId: 'win-1' }))).failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
    expect((await run(cmd({ externalTransactionId: 'r2', kind: 'REFUND', referenceExternalTransactionId: 'bet-1', money: { amount: '10.00', currency: 'BRL' } }))).failureCode).toBe(FailureCode.ReferenceAmountMismatch);
    expect((await run(cmd({ externalTransactionId: 'r3', kind: 'REFUND', referenceExternalTransactionId: 'bet-1', roundId: 'other' }))).failureCode).toBe(FailureCode.ReferenceMismatch);
  });

  it('ROLLBACK de BET credita; de WIN debita; de REFUND debita', async () => {
    await run(cmd({ externalTransactionId: 'bet-1' })); // 75
    await run(cmd({ externalTransactionId: 'win-1', kind: 'WIN', money: { amount: '10.00', currency: 'BRL' } })); // 85
    expect((await run(cmd({ externalTransactionId: 'rb-bet', kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1' }))).balance.amount).toBe('110.00');
    expect((await run(cmd({ externalTransactionId: 'rb-win', kind: 'ROLLBACK', referenceExternalTransactionId: 'win-1', money: { amount: '10.00', currency: 'BRL' } }))).balance.amount).toBe('100.00');
    await run(cmd({ externalTransactionId: 'bet-2', roundId: 'round-2' })); // 75
    await run(cmd({ externalTransactionId: 'ref-2', kind: 'REFUND', referenceExternalTransactionId: 'bet-2', roundId: 'round-2' })); // 100
    const rbRefund = await run(cmd({ externalTransactionId: 'rb-ref', kind: 'ROLLBACK', referenceExternalTransactionId: 'ref-2', roundId: 'round-2' }));
    expect(rbRefund.status).toBe(WagerTransactionStatus.Processed);
    expect(rbRefund.balance.amount).toBe('75.00');
    const dirs = ledgerOf().map((e) => e.direction as string);
    expect(dirs).toEqual(['CREDIT', 'DEBIT', 'CREDIT', 'CREDIT', 'DEBIT', 'DEBIT', 'CREDIT', 'DEBIT']);
  });

  it('ROLLBACK de WIN que deixaria saldo negativo → REVERSAL_INSUFFICIENT_FUNDS (código distinto)', async () => {
    await run(cmd({ externalTransactionId: 'win-1', kind: 'WIN', money: { amount: '50.00', currency: 'BRL' } })); // 150
    await run(cmd({ externalTransactionId: 'bet-1', money: { amount: '140.00', currency: 'BRL' } })); // 10
    const rb = await run(cmd({ externalTransactionId: 'rb', kind: 'ROLLBACK', referenceExternalTransactionId: 'win-1', money: { amount: '50.00', currency: 'BRL' } }));
    expect(rb.status).toBe(WagerTransactionStatus.Rejected);
    expect(rb.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(rb.failureCode).not.toBe(FailureCode.InsufficientFunds);
    expect(uow.wallets.get(walletId)!.balance.amount).toBe('10.00');
  });

  it('ROLLBACK de LOSS ou de ROLLBACK não é permitido', async () => {
    await run(cmd({ externalTransactionId: 'bet-1' }));
    await run(cmd({ externalTransactionId: 'loss-1', kind: 'LOSS' }));
    await run(cmd({ externalTransactionId: 'rb-1', kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1' }));
    expect((await run(cmd({ externalTransactionId: 'x1', kind: 'ROLLBACK', referenceExternalTransactionId: 'loss-1' }))).failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
    expect((await run(cmd({ externalTransactionId: 'x2', kind: 'ROLLBACK', referenceExternalTransactionId: 'rb-1' }))).failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
  });

  it('referência REJECTED não pode ser revertida', async () => {
    await run(cmd({ externalTransactionId: 'bet-big', money: { amount: '999.00', currency: 'BRL' } }));
    const r = await run(cmd({ externalTransactionId: 'ref', kind: 'REFUND', referenceExternalTransactionId: 'bet-big', money: { amount: '999.00', currency: 'BRL' } }));
    expect(r.failureCode).toBe(FailureCode.ReferenceNotProcessed);
  });

  it('conflito de moeda → REJECTED CURRENCY_MISMATCH sem tocar no saldo', async () => {
    const out = await run(cmd({ externalTransactionId: 'usd', money: { amount: '1.00', currency: 'USD' } }));
    expect(out.status).toBe(WagerTransactionStatus.Rejected);
    expect(out.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(out.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(ledgerOf()).toHaveLength(1);
  });

  it('player que não é dono da wallet → PLAYER_WALLET_MISMATCH', async () => {
    const out = await run(cmd({ externalTransactionId: 'x', playerId: crypto.randomUUID() }));
    expect(out.failureCode).toBe(FailureCode.PlayerWalletMismatch);
  });

  it('wallet inexistente → WalletNotFoundError (nada persistido)', async () => {
    await expect(run(cmd({ externalTransactionId: 'x', walletId: crypto.randomUUID() }))).rejects.toBeInstanceOf(WalletNotFoundError);
    expect(uow.transactions.size).toBe(1); // só a OPENING
  });

  it('replay: mesma key e mesmo payload devolve o resultado original com idempotentReplay=true', async () => {
    const first = await run(cmd({ externalTransactionId: 'bet-1' }));
    await run(cmd({ externalTransactionId: 'win-1', kind: 'WIN', money: { amount: '30.00', currency: 'BRL' } })); // saldo muda depois
    const replay = await run(cmd({ externalTransactionId: 'bet-1' }));
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.balance.amount).toBe('75.00'); // saldo observado na época, não o atual
    expect(ledgerOf()).toHaveLength(3);
  });

  it('replay de uma rejeição também é replay', async () => {
    const first = await run(cmd({ externalTransactionId: 'big', money: { amount: '500.00', currency: 'BRL' } }));
    const replay = await run(cmd({ externalTransactionId: 'big', money: { amount: '500.00', currency: 'BRL' } }));
    expect(replay).toEqual({ ...first, idempotentReplay: true });
  });

  it('mesma key com payload diferente → IdempotencyConflictError, não replay', async () => {
    await run(cmd({ externalTransactionId: 'bet-1' }));
    await expect(run(cmd({ externalTransactionId: 'bet-1', money: { amount: '26.00', currency: 'BRL' } }))).rejects.toBeInstanceOf(IdempotencyConflictError);
    // amount "25.0" é o mesmo payload (normalizado) → replay
    expect((await run(cmd({ externalTransactionId: 'bet-1', money: { amount: '25.0', currency: 'BRL' } }))).idempotentReplay).toBe(true);
  });

  it('mesmo externalTransactionId com outra idempotency key → conflito', async () => {
    await run(cmd({ externalTransactionId: 'bet-1' }));
    await expect(run(cmd({ externalTransactionId: 'bet-1', idempotencyKey: 'outra' }))).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('entrada SQS: inbox deduplica por (consumer, messageId) dentro da mesma unidade', async () => {
    const sqsCtx = { correlationId: 'c', source: 'sqs' as const, inbox: { consumerName: 'c1', messageId: 'm1', payloadHash: 'h' } };
    const first = await useCase.execute(cmd({ externalTransactionId: 'bet-1' }), sqsCtx);
    expect(first.type).toBe('outcome');
    const second = await useCase.execute(cmd({ externalTransactionId: 'bet-1' }), { ...sqsCtx, inbox: { ...sqsCtx.inbox, messageId: 'm1' } });
    // já existe transação → replay (a inbox é registrada para o redelivery ser barato)
    expect(second.type).toBe('outcome');
    expect(uow.inbox.has('c1:m1')).toBe(true);
    expect(ledgerOf()).toHaveLength(2);
  });

  it('REFUND antes da BET fica PENDING_REFERENCE e resolve quando a BET chega', async () => {
    const pending = await run(cmd({ externalTransactionId: 'ref-1', kind: 'REFUND', referenceExternalTransactionId: 'bet-1' }));
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
    expect(uow.outbox.at(-1)!.eventType).toBe('WagerTransactionPendingReference');
    expect(ledgerOf()).toHaveLength(1);

    await run(cmd({ externalTransactionId: 'bet-1' })); // 75
    clock.advance(1000);
    const report = await retry.runOnce();
    expect(report).toMatchObject({ claimed: 1, processed: 1 });
    const tx = uow.transactions.get(pending.transactionId)!;
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(uow.wallets.get(walletId)!.balance.amount).toBe('100.00');
    expect(ledgerOf()).toHaveLength(3);
    // replay depois de resolvida devolve o estado atual (PROCESSED)
    const replay = await run(cmd({ externalTransactionId: 'ref-1', kind: 'REFUND', referenceExternalTransactionId: 'bet-1' }));
    expect(replay).toMatchObject({ status: WagerTransactionStatus.Processed, idempotentReplay: true });
  });

  it('referência que nunca chega: esgota tentativas → REJECTED REFERENCE_NOT_FOUND + evento', async () => {
    const pending = await run(cmd({ externalTransactionId: 'rb-1', kind: 'ROLLBACK', referenceExternalTransactionId: 'ghost' }));
    const statuses: string[] = [];
    for (let i = 0; i < 6; i++) {
      clock.advance(5000);
      await retry.runOnce();
      statuses.push(uow.transactions.get(pending.transactionId)!.status);
    }
    // 1ª chegada + 3 retries (maxAttempts=3) → rejeita na 4ª avaliação
    expect(statuses).toEqual(['PENDING_REFERENCE', 'PENDING_REFERENCE', 'REJECTED', 'REJECTED', 'REJECTED', 'REJECTED']);
    const tx = uow.transactions.get(pending.transactionId)!;
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(tx.referenceAttempts).toBe(3);
    expect(uow.outbox.filter((m) => m.eventType === 'WagerTransactionRejected')).toHaveLength(1);
    expect(uow.outbox.filter((m) => m.eventType === 'WagerTransactionPendingReference')).toHaveLength(3);
  });
});
