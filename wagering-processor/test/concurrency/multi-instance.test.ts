import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ApiClient, uuid } from '../helpers/api';
import { spawnApp, type SpawnedApp } from '../helpers/app';
import { queueUrl, testQueueNames } from '../helpers/env';
import { assertWalletConsistent, closeOrm, getOrm, sql, truncateAll } from '../helpers/db';
import { deleteQueues, queueDepth, sendWagerMessage, waitFor } from '../helpers/sqs';

describe('três instâncias simultâneas', () => {
  const names = testQueueNames('multi');
  let instances: SpawnedApp[] = [];
  let apis: ApiClient[] = [];

  beforeAll(async () => {
    await getOrm();
    await truncateAll();
    instances = await Promise.all([spawnApp({}, 'multi'), spawnApp({}, 'multi'), spawnApp({}, 'multi')]);
    apis = instances.map((i) => new ApiClient(i.url));
  });
  afterAll(async () => {
    await Promise.all(instances.map((i) => i.stop()));
    await deleteQueues([queueUrl(names.wager), queueUrl(names.dlq), queueUrl(names.events)]);
    await closeOrm();
  });

  it('HTTP round-robin + SQS, com duplicatas, sobre wallets quentes: tudo exatamente uma vez', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 6 }, async (_, i) => {
        const playerId = uuid();
        const walletId = (await apis[i % 3]!.createWallet(playerId, '100.00')).body.id as string;
        return { playerId, walletId };
      }),
    );

    type Op = { playerId: string; walletId: string; externalTransactionId: string; kind: string; amount: string; roundId: string };
    const ops: Op[] = wallets.flatMap(({ playerId, walletId }, w) => [
      ...Array.from({ length: 25 }, (_, i) => ({ playerId, walletId, externalTransactionId: `w${w}-bet-${i}`, kind: 'BET', amount: '2.00', roundId: `r${i}` })),
      ...Array.from({ length: 25 }, (_, i) => ({ playerId, walletId, externalTransactionId: `w${w}-win-${i}`, kind: 'WIN', amount: '2.00', roundId: `r${i}` })),
    ]);
    const shuffled = [...ops].sort(() => Math.random() - 0.5);

    const viaHttp = shuffled.filter((_, i) => i % 2 === 0);
    const viaSqs = shuffled.filter((_, i) => i % 2 === 1);

    const httpCalls = viaHttp.flatMap((op, i) => {
      const call = () => apis[i % 3]!.submit(op);
      // 1 em 5 vai em dobro, para instâncias diferentes, ao mesmo tempo
      return i % 5 === 0 ? [call(), apis[(i + 1) % 3]!.submit(op)] : [call()];
    });
    const sqsSends = viaSqs.flatMap((op, i) => {
      const send = (messageId: string) => sendWagerMessage(queueUrl(names.wager), { ...op, providerId: 'provider-a', messageId });
      return i % 5 === 0 ? [send(`m-${op.externalTransactionId}`), send(`m-${op.externalTransactionId}`)] : [send(`m-${op.externalTransactionId}`)];
    });

    const started = performance.now();
    const [httpResults] = await Promise.all([Promise.all(httpCalls), Promise.all(sqsSends)]);
    expect(httpResults.every((r) => r.status === 200 || r.status === 422)).toBe(true);

    await waitFor(async () => {
      const d = await queueDepth(queueUrl(names.wager));
      return d.visible === 0 && d.inFlight === 0;
    }, { timeoutMs: 90000, label: 'queue drained' });
    await waitFor(async () => {
      const [row] = await sql<{ n: string }>("SELECT count(*)::text AS n FROM wager_transactions WHERE kind <> 'OPENING' AND status IN ('PROCESSED','REJECTED')");
      return Number(row!.n) === ops.length;
    }, { timeoutMs: 30000, label: 'all ops terminal' });
    const elapsed = performance.now() - started;

    // exatamente uma transação por externalTransactionId
    const [dups] = await sql<{ n: string }>('SELECT count(*)::text AS n FROM (SELECT external_transaction_id FROM wager_transactions GROUP BY 1 HAVING count(*) > 1) d');
    expect(Number(dups!.n)).toBe(0);
    const [total] = await sql<{ n: string }>("SELECT count(*)::text AS n FROM wager_transactions WHERE kind <> 'OPENING'");
    expect(Number(total!.n)).toBe(ops.length);

    for (const { walletId } of wallets) {
      const { balance, entries } = await assertWalletConsistent(walletId);
      // saldo final depende da ordem (BETs podem ser rejeitadas), mas:
      // wins são sempre creditados; entries = 1 + bets processadas + 25
      const [row] = await sql<{ bets: string; rejected: string }>("SELECT count(*) FILTER (WHERE kind='BET' AND status='PROCESSED')::text AS bets, count(*) FILTER (WHERE status='REJECTED')::text AS rejected FROM wager_transactions WHERE wallet_id = ?", [walletId]);
      const bets = Number(row!.bets);
      expect(Number(balance)).toBe(100 - 2 * bets + 2 * 25);
      expect(entries).toBe(1 + bets + 25);
    }

    // as três instâncias trabalharam de verdade
    const counts = await Promise.all(
      instances.map(async (i) => {
        const text = await fetch(`${i.url}/metrics`).then((r) => r.text());
        return [...text.matchAll(/wager_transactions_total\{[^}]*\} (\d+)/g)].reduce((s, m) => s + Number(m[1]), 0);
      }),
    );
    expect(counts.every((c) => c > 0)).toBe(true);
    expect((await queueDepth(queueUrl(names.dlq))).visible).toBe(0);
    console.log(`${ops.length} ops (+duplicatas) em 3 instâncias: ${elapsed.toFixed(0)}ms; por instância: ${counts.join(' / ')}`);
  });
});
