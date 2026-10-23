import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { NoopLogger } from '../../src/application/ports/logger';
import { NoopMetrics } from '../../src/application/ports/metrics';
import { ProcessWagerTransactionUseCase } from '../../src/application/wagering/process-wager-transaction.use-case';
import { OpenWalletUseCase } from '../../src/application/wallets/open-wallet.use-case';
import { SystemClock } from '../../src/domain/shared/clock';
import { WalletBalanceChanged } from '../../src/domain/messaging/events';
import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { Money } from '../../src/domain/money/money';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wagering/wager-transaction';
import { DEFAULT_REFERENCE_RETRY_POLICY } from '../../src/domain/wagering/reference-retry-policy';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { assertWalletConsistent, closeOrm, getOrm, ledgerRows, sql, truncateAll } from '../helpers/db';

describe('atomicidade entre wallet, ledger, inbox e outbox', () => {
  let uow: MikroOrmUnitOfWork;
  const clock = new SystemClock();
  const logger = new NoopLogger();
  const metrics = new NoopMetrics();
  const policy = { policy: DEFAULT_REFERENCE_RETRY_POLICY };

  beforeAll(async () => {
    uow = new MikroOrmUnitOfWork(await getOrm());
    await truncateAll();
  });
  afterAll(closeOrm);

  it('falha no fim da unidade desfaz tudo: wallet, transação, ledger, inbox e outbox', async () => {
    const wallet = await new OpenWalletUseCase(uow, clock, logger).execute({ playerId: crypto.randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } }, { correlationId: 'c' });
    const before = await snapshot(wallet.id);

    await expect(
      uow.run(async (repos) => {
        const w = (await repos.wallets.findByIdForUpdate(wallet.id))!;
        const tx = WagerTransaction.create({
          providerId: 'p', externalTransactionId: 'e', idempotencyKey: 'k', payloadHash: 'h'.repeat(64), walletId: w.id, playerId: w.playerId,
          roundId: 'r', gameId: 'g', kind: WagerTransactionKind.Bet, money: Money.from({ amount: '10.00', currency: 'BRL' }), createdAt: clock.now(),
        });
        await repos.transactions.insert(tx);
        const versionBefore = w.version;
        const entry = w.debit(tx.id, tx.money, clock.now());
        tx.markProcessed(undefined, clock.now(), w.balance);
        await repos.transactions.update(tx);
        await repos.ledger.insert(entry);
        await repos.wallets.update(w, versionBefore);
        await repos.inbox.tryInsert(InboxMessage.receive({ consumerName: 'c', messageId: 'm', payloadHash: 'h'.repeat(64), receivedAt: clock.now() }));
        await repos.outbox.enqueue([OutboxMessage.enqueue(WalletBalanceChanged.from(w, entry, { correlationId: 'c' }))]);
        throw new Error('boom right before commit');
      }),
    ).rejects.toThrow('boom');

    expect(await snapshot(wallet.id)).toEqual(before);
    await assertWalletConsistent(wallet.id);
  });

  it('sucesso persiste os quatro juntos', async () => {
    const wallet = await new OpenWalletUseCase(uow, clock, logger).execute({ playerId: crypto.randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } }, { correlationId: 'c' });
    const useCase = new ProcessWagerTransactionUseCase(uow, clock, policy, metrics, logger);
    const result = await useCase.execute(
      { providerId: 'p', externalTransactionId: 'e2', idempotencyKey: 'p:e2', playerId: wallet.playerId, walletId: wallet.id, roundId: 'r', gameId: 'g', kind: WagerTransactionKind.Bet, money: { amount: '10.00', currency: 'BRL' } },
      { correlationId: 'c', source: 'sqs', inbox: { consumerName: 'c', messageId: 'm2', payloadHash: 'h'.repeat(64) } },
    );
    expect(result.type).toBe('outcome');
    const s = await snapshot(wallet.id);
    expect(s.transactions).toBe(2); // OPENING + BET
    expect(s.ledger).toBe(2);
    expect(s.inbox).toBe(1);
    expect(s.outbox).toBe(4); // WalletOpened, BalanceChanged (opening), Processed, BalanceChanged
    expect(s.balance).toBe('90.00');
    const [inbox] = await sql<{ processed_at: Date | null }>("SELECT processed_at FROM inbox_messages WHERE message_id = 'm2'");
    expect(inbox!.processed_at).not.toBeNull();
    await assertWalletConsistent(wallet.id);
  });

  it('UPDATE condicionado detecta lost update (versão divergente)', async () => {
    const wallet = await new OpenWalletUseCase(uow, clock, logger).execute({ playerId: crypto.randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } }, { correlationId: 'c' });
    await expect(
      uow.run(async (repos) => {
        const w = (await repos.wallets.findById(wallet.id))!;
        w.credit('x', Money.from({ amount: '1.00', currency: 'BRL' }), clock.now());
        await repos.wallets.update(w, 99); // versão errada
      }),
    ).rejects.toThrow(/version conflict/);
    const [row] = await sql<{ balance_amount: string; version: number }>('SELECT balance_amount, version FROM wallets WHERE id = ?', [wallet.id]);
    expect(row).toEqual({ balance_amount: '100.00', version: 1 });
  });

  async function snapshot(walletId: string) {
    const [w] = await sql<{ balance_amount: string; version: number }>('SELECT balance_amount, version FROM wallets WHERE id = ?', [walletId]);
    const [t] = await sql<{ n: string }>('SELECT count(*)::text AS n FROM wager_transactions WHERE wallet_id = ?', [walletId]);
    const [i] = await sql<{ n: string }>('SELECT count(*)::text AS n FROM inbox_messages');
    const [o] = await sql<{ n: string }>('SELECT count(*)::text AS n FROM outbox_messages WHERE aggregate_id = ?', [walletId]);
    return { balance: w!.balance_amount, version: w!.version, transactions: Number(t!.n), ledger: (await ledgerRows(walletId)).length, inbox: Number(i!.n), outbox: Number(o!.n) };
  }
});
