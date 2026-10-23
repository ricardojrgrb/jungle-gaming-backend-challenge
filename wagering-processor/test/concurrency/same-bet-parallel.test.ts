import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { BootstrappedApp } from '../../src/bootstrap';
import { ApiClient, uuid } from '../helpers/api';
import { startApp } from '../helpers/app';
import { queueUrl, testQueueNames } from '../helpers/env';
import { assertWalletConsistent, closeOrm, getOrm, ledgerRows, sql, transactionRows, truncateAll } from '../helpers/db';
import { deleteQueues, queueDepth, sendWagerMessage, waitFor } from '../helpers/sqs';

describe('a mesma aposta 50 vezes em paralelo', () => {
  const names = testQueueNames('same50');
  let app: BootstrappedApp;
  let api: ApiClient;

  beforeAll(async () => {
    await getOrm();
    await truncateAll();
    app = await startApp({ ENABLE_PENDING_REFERENCE_WORKER: 'false', DB_POOL_MAX: '10' }, 'same50');
    api = new ApiClient(app.url);
  });
  afterAll(async () => {
    await app.close();
    await deleteQueues([queueUrl(names.wager), queueUrl(names.dlq), queueUrl(names.events)]);
    await closeOrm();
  });

  it('HTTP: 50 requisições simultâneas com a mesma key → um débito, 49 replays', async () => {
    const playerId = uuid();
    const walletId = (await api.createWallet(playerId, '100.00')).body.id;
    const input = { externalTransactionId: 'same-bet', playerId, walletId, kind: 'BET', amount: '80.00' };

    const results = await Promise.all(Array.from({ length: 50 }, () => api.submit(input)));

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => r.body.status === 'PROCESSED')).toBe(true);
    const originals = results.filter((r) => r.body.idempotentReplay === false);
    const replays = results.filter((r) => r.body.idempotentReplay === true);
    expect(originals).toHaveLength(1);
    expect(replays).toHaveLength(49);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.every((r) => r.body.balance.amount === '20.00')).toBe(true);

    const ledger = await ledgerRows(walletId);
    expect(ledger.filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
    expect((await transactionRows(walletId)).filter((t) => t.kind === 'BET')).toHaveLength(1);
    expect(await assertWalletConsistent(walletId)).toEqual({ balance: '20.00', entries: 2 });
  });

  it('SQS: 50 mensagens (25 com o mesmo messageId, 25 com ids distintos e a mesma key) → um débito', async () => {
    const playerId = uuid();
    const walletId = (await api.createWallet(playerId, '100.00')).body.id;
    const base = { providerId: 'provider-a', externalTransactionId: 'same-sqs', playerId, walletId, roundId: 'r', kind: 'BET', amount: '80.00' };
    await Promise.all([
      ...Array.from({ length: 25 }, () => sendWagerMessage(queueUrl(names.wager), { ...base, messageId: 'dup-msg' })),
      ...Array.from({ length: 25 }, (_, i) => sendWagerMessage(queueUrl(names.wager), { ...base, messageId: `distinct-${i}` })),
    ]);
    await waitFor(async () => {
      const d = await queueDepth(queueUrl(names.wager));
      return d.visible === 0 && d.inFlight === 0;
    }, { timeoutMs: 60000, label: 'queue drained' });
    await Bun.sleep(300);

    expect((await ledgerRows(walletId)).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
    expect((await transactionRows(walletId)).filter((t) => t.kind === 'BET')).toHaveLength(1);
    const [inbox] = await sql<{ n: string }>("SELECT count(*)::text AS n FROM inbox_messages WHERE message_id = 'dup-msg' OR message_id LIKE 'distinct-%'");
    expect(Number(inbox!.n)).toBe(26); // 1 do messageId repetido + 25 distintos
    expect((await queueDepth(queueUrl(names.dlq))).visible).toBe(0);
    expect(await assertWalletConsistent(walletId)).toEqual({ balance: '20.00', entries: 2 });
  });
});
