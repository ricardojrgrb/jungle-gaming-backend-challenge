import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { BootstrappedApp } from '../../src/bootstrap';
import { ApiClient, uuid } from '../helpers/api';
import { startApp } from '../helpers/app';
import { queueUrl, testQueueNames } from '../helpers/env';
import { assertWalletConsistent, closeOrm, getOrm, ledgerRows, transactionRows, truncateAll } from '../helpers/db';
import { deleteQueues } from '../helpers/sqs';

describe('disputa pelo saldo da mesma wallet', () => {
  const names = testQueueNames('hot');
  let app: BootstrappedApp;
  let api: ApiClient;

  beforeAll(async () => {
    await getOrm();
    await truncateAll();
    app = await startApp({ ENABLE_SQS_CONSUMER: 'false', ENABLE_PENDING_REFERENCE_WORKER: 'false', DB_POOL_MAX: '20' }, 'hot');
    api = new ApiClient(app.url);
  });
  afterAll(async () => {
    await app.close();
    await deleteQueues([queueUrl(names.wager), queueUrl(names.dlq), queueUrl(names.events)]);
    await closeOrm();
  });

  it('cenário obrigatório: 100.00, duas apostas de 80.00 simultâneas (repetido 10x)', async () => {
    for (let round = 0; round < 10; round++) {
      const playerId = uuid();
      const walletId = (await api.createWallet(playerId, '100.00')).body.id;
      const [a, b] = await Promise.all([
        api.submit({ externalTransactionId: `a-${round}`, playerId, walletId, kind: 'BET', amount: '80.00' }),
        api.submit({ externalTransactionId: `b-${round}`, playerId, walletId, kind: 'BET', amount: '80.00' }),
      ]);
      const statuses = [a.body.status, b.body.status].sort();
      expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
      const rejected = a.body.status === 'REJECTED' ? a : b;
      expect(rejected.status).toBe(422);
      expect(rejected.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(rejected.body.balance.amount).toBe('20.00');
      expect((await api.get(`/wallets/${walletId}`)).body.balance.amount).toBe('20.00');
      expect((await ledgerRows(walletId)).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
      expect(await assertWalletConsistent(walletId)).toEqual({ balance: '20.00', entries: 2 });
    }
  });

  it('hot wallet: 60 operações concorrentes misturando BET/WIN/LOSS nunca deixam saldo negativo nem perdem update', async () => {
    const playerId = uuid();
    const walletId = (await api.createWallet(playerId, '50.00')).body.id;
    const ops = [
      ...Array.from({ length: 30 }, (_, i) => ({ externalTransactionId: `bet-${i}`, playerId, walletId, kind: 'BET', amount: '7.00', roundId: `r${i}` })),
      ...Array.from({ length: 20 }, (_, i) => ({ externalTransactionId: `win-${i}`, playerId, walletId, kind: 'WIN', amount: '3.00', roundId: `r${i}` })),
      ...Array.from({ length: 10 }, (_, i) => ({ externalTransactionId: `loss-${i}`, playerId, walletId, kind: 'LOSS', amount: '7.00', roundId: `r${i}` })),
    ].sort(() => Math.random() - 0.5);

    const results = await Promise.all(ops.map((op) => api.submit(op)));
    expect(results.every((r) => r.status === 200 || r.status === 422)).toBe(true);

    const txs = await transactionRows(walletId);
    const processed = txs.filter((t) => t.status === 'PROCESSED');
    const bets = processed.filter((t) => t.kind === 'BET').length;
    const wins = processed.filter((t) => t.kind === 'WIN').length;
    expect(wins).toBe(20); // crédito nunca é rejeitado
    expect(processed.filter((t) => t.kind === 'LOSS')).toHaveLength(10);
    expect(txs.filter((t) => t.status === 'REJECTED').every((t) => t.failure_code === 'INSUFFICIENT_FUNDS')).toBe(true);

    const expected = 50 - 7 * bets + 3 * 20;
    const { balance, entries } = await assertWalletConsistent(walletId);
    expect(Number(balance)).toBe(expected);
    expect(Number(balance)).toBeGreaterThanOrEqual(0);
    expect(entries).toBe(1 + bets + wins); // LOSS não gera lançamento
    expect((await api.get(`/wallets/${walletId}`)).body.version).toBe(entries);
  });

  it('wallets distintas em paralelo não se bloqueiam e ficam todas consistentes', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const playerId = uuid();
        const walletId = (await api.createWallet(playerId, '100.00')).body.id as string;
        return { playerId, walletId };
      }),
    );
    const started = performance.now();
    const results = await Promise.all(
      wallets.flatMap(({ playerId, walletId }) =>
        Array.from({ length: 10 }, (_, i) => api.submit({ externalTransactionId: `${walletId}-${i}`, playerId, walletId, kind: 'BET', amount: '1.00', roundId: `r${i}` })),
      ),
    );
    const elapsedMs = performance.now() - started;
    expect(results.every((r) => r.status === 200 && r.body.status === 'PROCESSED')).toBe(true);
    for (const { walletId } of wallets) {
      expect(await assertWalletConsistent(walletId)).toEqual({ balance: '90.00', entries: 11 });
    }
    // 200 operações; se as wallets se serializassem entre si isso levaria bem mais.
    console.log(`200 ops em 20 wallets: ${elapsedMs.toFixed(0)}ms`);
  });
});
