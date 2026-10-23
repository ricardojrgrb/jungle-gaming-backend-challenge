import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { BootstrappedApp } from '../../src/bootstrap';
import { ApiClient, uuid } from '../helpers/api';
import { startApp } from '../helpers/app';
import { testQueueNames, queueUrl } from '../helpers/env';
import { assertWalletConsistent, closeOrm, getOrm, ledgerRows, sql, transactionRows, truncateAll } from '../helpers/db';
import { deleteQueues, drainQueue, queueDepth, sendWagerMessage, waitFor } from '../helpers/sqs';

describe('inbox persistente e redelivery', () => {
  let app: BootstrappedApp;
  let api: ApiClient;
  const names = testQueueNames('inbox');

  beforeAll(async () => {
    await getOrm();
    await truncateAll();
    app = await startApp({ ENABLE_PENDING_REFERENCE_WORKER: 'false' }, 'inbox');
    api = new ApiClient(app.url);
  });
  afterAll(async () => {
    await app.close();
    await deleteQueues([queueUrl(names.wager), queueUrl(names.dlq), queueUrl(names.events)]);
    await closeOrm();
  });

  it('a mesma mensagem entregue 3 vezes produz um único débito e três acks', async () => {
    const playerId = uuid();
    const walletId = (await api.createWallet(playerId, '100.00')).body.id;
    const input = { messageId: 'msg-dup-1', providerId: 'provider-a', externalTransactionId: 'sqs-bet-1', playerId, walletId, roundId: 'r1', kind: 'BET', amount: '10.00' };

    await sendWagerMessage(queueUrl(names.wager), input);
    await waitFor(async () => (await transactionRows(walletId)).some((t) => t.external_transaction_id === 'sqs-bet-1' && t.status === 'PROCESSED'), { label: 'first delivery' });

    // "redelivery": mesmo messageId, novo envio
    await sendWagerMessage(queueUrl(names.wager), input);
    await sendWagerMessage(queueUrl(names.wager), input);
    await waitFor(async () => {
      const d = await queueDepth(queueUrl(names.wager));
      return d.visible === 0 && d.inFlight === 0;
    }, { label: 'queue drained' });

    const [inbox] = await sql<{ n: string }>("SELECT count(*)::text AS n FROM inbox_messages WHERE message_id = 'msg-dup-1'");
    expect(Number(inbox!.n)).toBe(1);
    expect((await ledgerRows(walletId)).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
    expect((await api.get(`/wallets/${walletId}`)).body.balance.amount).toBe('90.00');
    const metrics = await fetch(`${app.url}/metrics`).then((r) => r.text());
    expect(metrics).toMatch(/wager_inbox_duplicates_total 2/);
    expect((await queueDepth(queueUrl(names.dlq))).visible).toBe(0);
    await assertWalletConsistent(walletId);
  });

  it('messageIds diferentes com a mesma idempotency key: um débito, os demais são replay', async () => {
    const playerId = uuid();
    const walletId = (await api.createWallet(playerId, '100.00')).body.id;
    for (let i = 0; i < 5; i++) {
      await sendWagerMessage(queueUrl(names.wager), { messageId: `msg-k-${i}`, providerId: 'provider-a', externalTransactionId: 'sqs-bet-k', playerId, walletId, roundId: 'r1', kind: 'BET', amount: '10.00' });
    }
    await waitFor(async () => {
      const d = await queueDepth(queueUrl(names.wager));
      return d.visible === 0 && d.inFlight === 0;
    }, { label: 'queue drained' });
    await Bun.sleep(300);
    expect((await ledgerRows(walletId)).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
    const [inbox] = await sql<{ n: string }>("SELECT count(*)::text AS n FROM inbox_messages WHERE message_id LIKE 'msg-k-%'");
    expect(Number(inbox!.n)).toBe(5);
    await assertWalletConsistent(walletId);
  });

  it('a mesma operação via HTTP e via fila: uma só vez', async () => {
    const playerId = uuid();
    const walletId = (await api.createWallet(playerId, '100.00')).body.id;
    const http = await api.submit({ externalTransactionId: 'both', playerId, walletId, kind: 'BET', amount: '30.00' });
    expect(http.status).toBe(200);
    await sendWagerMessage(queueUrl(names.wager), { messageId: 'msg-both', providerId: 'provider-a', externalTransactionId: 'both', playerId, walletId, roundId: 'round-1', kind: 'BET', amount: '30.00' });
    await waitFor(async () => (await sql("SELECT 1 FROM inbox_messages WHERE message_id = 'msg-both' AND processed_at IS NOT NULL")).length === 1, { label: 'inbox recorded' });
    expect((await api.get(`/wallets/${walletId}`)).body.balance.amount).toBe('70.00');
    expect((await ledgerRows(walletId)).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
    await assertWalletConsistent(walletId);
  });

  it('eventos publicados carregam eventId único e chegam na fila de eventos', async () => {
    const events = await drainQueue(queueUrl(names.events), { maxWaitMs: 5000 });
    expect(events.length).toBeGreaterThan(0);
    const ids = events.map((m) => JSON.parse(m.Body!).eventId);
    expect(new Set(ids).size).toBe(ids.length);
    const types = new Set(events.map((m) => JSON.parse(m.Body!).eventType));
    expect([...types].sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged', 'WalletOpened']);
  });
});
