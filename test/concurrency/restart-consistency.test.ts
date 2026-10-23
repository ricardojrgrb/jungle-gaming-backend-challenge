import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ApiClient, uuid } from '../helpers/api';
import { spawnApp } from '../helpers/app';
import { queueUrl, testQueueNames } from '../helpers/env';
import { assertWalletConsistent, closeOrm, getOrm, outboxRows, sql, truncateAll } from '../helpers/db';
import { deleteQueues, queueDepth, sendWagerMessage, waitFor } from '../helpers/sqs';

describe('reinício do serviço no meio do processamento', () => {
  const names = testQueueNames('restart2');
  beforeAll(async () => {
    await getOrm();
    await truncateAll();
  });
  afterAll(async () => {
    await deleteQueues([queueUrl(names.wager), queueUrl(names.dlq), queueUrl(names.events)]);
    await closeOrm();
  });

  it('kill -9 com 200 operações em voo; depois do restart tudo converge e o ledger fecha', async () => {
    const flags = { SQS_VISIBILITY_TIMEOUT_SECONDS: '3', OUTBOX_POLL_INTERVAL_MS: '50' };
    let app = await spawnApp(flags, 'restart2');
    const playerId = uuid();
    const walletId = (await new ApiClient(app.url).createWallet(playerId, '1000.00')).body.id as string;

    const sqsOps = Array.from({ length: 150 }, (_, i) => ({ messageId: `rs-${i}`, providerId: 'provider-a', externalTransactionId: `sqs-${i}`, playerId, walletId, roundId: `r${i}`, kind: i % 3 === 0 ? 'WIN' : 'BET', amount: '1.00' }));
    const httpOps = Array.from({ length: 50 }, (_, i) => ({ externalTransactionId: `http-${i}`, playerId, walletId, roundId: `h${i}`, kind: 'BET', amount: '1.00' }));

    // dispara tudo e mata o processo logo em seguida
    const sends = Promise.all(sqsOps.map((op) => sendWagerMessage(queueUrl(names.wager), op)));
    const api1 = new ApiClient(app.url);
    const httpAttempts = httpOps.map((op) => api1.submit(op).then((r) => ({ op, ok: r.status === 200 || r.status === 422 })).catch(() => ({ op, ok: false })));
    await Bun.sleep(250);
    const killedAt = Date.now();
    await app.stop('SIGKILL');
    await sends;
    const firstPass = await Promise.all(httpAttempts);
    const failedHttp = firstPass.filter((r) => !r.ok).map((r) => r.op);
    console.log(`kill -9 após 250ms: ${firstPass.length - failedHttp.length} HTTP ok antes de morrer, ${failedHttp.length} para reenviar`);

    app = await spawnApp(flags, 'restart2');
    try {
      const api2 = new ApiClient(app.url);
      // o provedor reenvia o que falhou, com a mesma idempotency key
      const retried = await Promise.all(failedHttp.map((op) => api2.submit(op)));
      expect(retried.every((r) => r.status === 200)).toBe(true);

      await waitFor(async () => {
        const d = await queueDepth(queueUrl(names.wager));
        return d.visible === 0 && d.inFlight === 0;
      }, { timeoutMs: 90000, label: 'queue drained' });
      await waitFor(async () => {
        const [row] = await sql<{ n: string }>("SELECT count(*)::text AS n FROM wager_transactions WHERE kind <> 'OPENING' AND status = 'PROCESSED'");
        return Number(row!.n) === 200;
      }, { timeoutMs: 30000, label: 'all processed' });
      await waitFor(async () => (await outboxRows('WHERE published_at IS NULL')).length === 0, { timeoutMs: 30000, label: 'outbox drained' });

      const [dups] = await sql<{ n: string }>('SELECT count(*)::text AS n FROM (SELECT external_transaction_id FROM wager_transactions GROUP BY 1 HAVING count(*) > 1) d');
      expect(Number(dups!.n)).toBe(0);
      const wins = sqsOps.filter((o) => o.kind === 'WIN').length;
      const bets = 200 - wins;
      expect(await assertWalletConsistent(walletId)).toEqual({ balance: (1000 - bets + wins).toFixed(2), entries: 201 });
      const recon = await api2.post(`/wallets/${walletId}/reconciliation`);
      expect(recon.body.consistent).toBe(true);
      expect(recon.body.checkedEntries).toBe(201);
      expect((await queueDepth(queueUrl(names.dlq))).visible).toBe(0);
      console.log(`convergiu ${((Date.now() - killedAt) / 1000).toFixed(1)}s depois do kill`);
    } finally {
      await app.stop();
    }
  });
});
