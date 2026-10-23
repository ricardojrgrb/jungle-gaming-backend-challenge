import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { uuid } from '../helpers/api';
import { spawnApp, startApp } from '../helpers/app';
import { queueUrl, testQueueNames } from '../helpers/env';
import { assertWalletConsistent, closeOrm, getOrm, ledgerRows, sql, truncateAll } from '../helpers/db';
import { deleteQueues, queueDepth, sendWagerMessage, waitFor } from '../helpers/sqs';
import { ApiClient } from '../helpers/api';

describe('worker morto depois do commit e antes do ack', () => {
  const names = testQueueNames('crash');
  beforeAll(async () => {
    await getOrm();
    await truncateAll();
  });
  afterAll(async () => {
    await deleteQueues([queueUrl(names.wager), queueUrl(names.dlq), queueUrl(names.events)]);
    await closeOrm();
  });

  it('a redelivery bate na inbox: nenhum efeito duplicado, mensagem confirmada pela próxima instância', async () => {
    // Wallet criada por uma instância sem consumidor.
    const setup = await startApp({ ENABLE_SQS_CONSUMER: 'false', ENABLE_OUTBOX_PUBLISHER: 'false', ENABLE_PENDING_REFERENCE_WORKER: 'false' }, 'crash');
    const playerId = uuid();
    const walletId = (await new ApiClient(setup.url).createWallet(playerId, '100.00')).body.id as string;
    await setup.close();

    // Processo A: vai commitar e morrer antes do DeleteMessage.
    const a = await spawnApp({ FAULT_INJECTION: 'sqs:after-commit-before-ack', SQS_VISIBILITY_TIMEOUT_SECONDS: '3', ENABLE_OUTBOX_PUBLISHER: 'false', ENABLE_PENDING_REFERENCE_WORKER: 'false' }, 'crash');
    await sendWagerMessage(queueUrl(names.wager), { messageId: 'crash-msg', providerId: 'provider-a', externalTransactionId: 'crash-bet', playerId, walletId, roundId: 'r', kind: 'BET', amount: '40.00' });
    const exitCode = await Promise.race([a.exited, Bun.sleep(20000).then(() => -1)]);
    expect(exitCode).toBe(137);
    expect(a.logs()).toContain('crashing at sqs:after-commit-before-ack');

    // O commit aconteceu...
    const [tx] = await sql<{ status: string }>("SELECT status FROM wager_transactions WHERE external_transaction_id = 'crash-bet'");
    expect(tx?.status).toBe('PROCESSED');
    expect((await ledgerRows(walletId)).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
    // ...mas a mensagem não foi confirmada: ainda está na fila (invisível até o timeout).
    const depth = await queueDepth(queueUrl(names.wager));
    expect(depth.visible + depth.inFlight).toBe(1);

    // Processo B assume. Recebe a redelivery, encontra a inbox, dá o ack.
    const b = await spawnApp({ SQS_VISIBILITY_TIMEOUT_SECONDS: '3', ENABLE_OUTBOX_PUBLISHER: 'false', ENABLE_PENDING_REFERENCE_WORKER: 'false' }, 'crash');
    try {
      await waitFor(async () => {
        const d = await queueDepth(queueUrl(names.wager));
        return d.visible === 0 && d.inFlight === 0;
      }, { timeoutMs: 30000, label: 'redelivery acked' });
      await Bun.sleep(300);
      const metrics = await fetch(`${b.url}/metrics`).then((r) => r.text());
      expect(metrics).toMatch(/wager_inbox_duplicates_total 1/);
      expect(metrics).toMatch(/sqs_messages_acked_total 1/);
      expect((await ledgerRows(walletId)).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
      const [inbox] = await sql<{ n: string }>("SELECT count(*)::text AS n FROM inbox_messages WHERE message_id = 'crash-msg'");
      expect(Number(inbox!.n)).toBe(1);
      expect((await queueDepth(queueUrl(names.dlq))).visible).toBe(0);
      expect(await assertWalletConsistent(walletId)).toEqual({ balance: '60.00', entries: 2 });
    } finally {
      await b.stop();
    }
  });
});
