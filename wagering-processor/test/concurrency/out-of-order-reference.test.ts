import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { BootstrappedApp } from '../../src/bootstrap';
import { ApiClient, uuid } from '../helpers/api';
import { startApp } from '../helpers/app';
import { queueUrl, testQueueNames } from '../helpers/env';
import { assertWalletConsistent, closeOrm, getOrm, ledgerRows, sql, truncateAll } from '../helpers/db';
import { deleteQueues, drainQueue, sendWagerMessage, waitFor } from '../helpers/sqs';

async function statusOf(ext: string) {
  const [row] = await sql<{ status: string; failure_code: string | null; reference_attempts: number }>('SELECT status, failure_code, reference_attempts FROM wager_transactions WHERE external_transaction_id = ?', [ext]);
  return row;
}

describe('REFUND / ROLLBACK entregues antes da referência', () => {
  const names = testQueueNames('ooo');
  let app: BootstrappedApp;
  let api: ApiClient;

  beforeAll(async () => {
    await getOrm();
    await truncateAll();
    // Backoff propositalmente longo: se a resolução acontecer rápido, foi o
    // "wake up" ao processar a referência, não o retry agendado.
    app = await startApp({ PENDING_REFERENCE_BASE_DELAY_MS: '60000', PENDING_REFERENCE_MAX_DELAY_MS: '60000', PENDING_REFERENCE_MAX_ATTEMPTS: '2' }, 'ooo');
    api = new ApiClient(app.url);
  });
  afterAll(async () => {
    await app.close();
    await deleteQueues([queueUrl(names.wager), queueUrl(names.dlq), queueUrl(names.events)]);
    await closeOrm();
  });

  it('REFUND chega antes da BET pela fila: fica pendente e resolve assim que a BET é processada', async () => {
    const playerId = uuid();
    const walletId = (await api.createWallet(playerId, '100.00')).body.id;
    await sendWagerMessage(queueUrl(names.wager), { messageId: 'm-refund', providerId: 'provider-a', externalTransactionId: 'bet-1', playerId, walletId, roundId: 'r1', kind: 'REFUND', amount: '30.00', referenceExternalTransactionId: 'bet-1-ref' }, 'g1');
    await waitFor(async () => (await statusOf('bet-1'))?.status === 'PENDING_REFERENCE', { label: 'refund pending' });
    expect((await ledgerRows(walletId))).toHaveLength(1);

    await sendWagerMessage(queueUrl(names.wager), { messageId: 'm-bet', providerId: 'provider-a', externalTransactionId: 'bet-1-ref', playerId, walletId, roundId: 'r1', kind: 'BET', amount: '30.00' }, 'g2');
    const t0 = Date.now();
    await waitFor(async () => (await statusOf('bet-1'))?.status === 'PROCESSED', { label: 'refund resolved', timeoutMs: 10000 });
    expect(Date.now() - t0).toBeLessThan(5000);

    const ledger = await ledgerRows(walletId);
    expect(ledger.map((e) => e.direction)).toEqual(['CREDIT', 'DEBIT', 'CREDIT']);
    expect(await assertWalletConsistent(walletId)).toEqual({ balance: '100.00', entries: 3 });
    const events = await drainQueue(queueUrl(names.events), { maxWaitMs: 4000 });
    const types = events.map((m) => JSON.parse(m.Body!).eventType);
    expect(types).toContain('WagerTransactionPendingReference');
  });

  it('ROLLBACK de WIN antes do WIN', async () => {
    const playerId = uuid();
    const walletId = (await api.createWallet(playerId, '10.00')).body.id;
    const rb = await api.submit({ externalTransactionId: 'rb-win', playerId, walletId, kind: 'ROLLBACK', amount: '25.00', referenceExternalTransactionId: 'win-1', roundId: 'r' });
    expect(rb.status).toBe(202);
    await api.submit({ externalTransactionId: 'win-1', playerId, walletId, kind: 'WIN', amount: '25.00', roundId: 'r' });
    await waitFor(async () => (await statusOf('rb-win'))?.status === 'PROCESSED', { label: 'rollback resolved', timeoutMs: 10000 });
    expect(await assertWalletConsistent(walletId)).toEqual({ balance: '10.00', entries: 3 });
    expect((await ledgerRows(walletId)).map((e) => e.direction)).toEqual(['CREDIT', 'CREDIT', 'DEBIT']);
  });

  it('referência chega mas foi REJECTED: a reversão é rejeitada (REFERENCE_NOT_PROCESSED), não fica presa', async () => {
    const playerId = uuid();
    const walletId = (await api.createWallet(playerId, '10.00')).body.id;
    await api.submit({ externalTransactionId: 'rb-bet', playerId, walletId, kind: 'ROLLBACK', amount: '50.00', referenceExternalTransactionId: 'big-bet', roundId: 'r' });
    await api.submit({ externalTransactionId: 'big-bet', playerId, walletId, kind: 'BET', amount: '50.00', roundId: 'r' }); // sem saldo → REJECTED
    await waitFor(async () => (await statusOf('rb-bet'))?.status === 'REJECTED', { label: 'rollback rejected', timeoutMs: 10000 });
    expect((await statusOf('rb-bet'))?.failure_code).toBe('REFERENCE_NOT_PROCESSED');
    expect(await assertWalletConsistent(walletId)).toEqual({ balance: '10.00', entries: 1 });
  });

  it('referência que nunca chega: esgota as tentativas e vira REJECTED REFERENCE_NOT_FOUND com evento', async () => {
    const playerId = uuid();
    const walletId = (await api.createWallet(playerId, '10.00')).body.id;
    await api.submit({ externalTransactionId: 'orphan', playerId, walletId, kind: 'REFUND', amount: '1.00', referenceExternalTransactionId: 'ghost', roundId: 'r' });
    // encurta o backoff "na mão" para o teste não esperar 60s por tentativa
    for (let i = 0; i < 3; i++) {
      await sql("UPDATE wager_transactions SET next_reference_retry_at = now() - interval '1 second' WHERE external_transaction_id = 'orphan' AND status = 'PENDING_REFERENCE'");
      await Bun.sleep(400);
    }
    const row = await waitFor(async () => {
      const r = await statusOf('orphan');
      return r?.status === 'REJECTED' ? r : null;
    }, { label: 'orphan rejected', timeoutMs: 10000 });
    expect(row.failure_code).toBe('REFERENCE_NOT_FOUND');
    expect(row.reference_attempts).toBe(2);
    expect((await api.get('/providers/provider-a/wagering/transactions/orphan')).body.status).toBe('REJECTED');
    const events = await drainQueue(queueUrl(names.events), { maxWaitMs: 4000 });
    const rejected = events.map((m) => JSON.parse(m.Body!)).filter((e) => e.eventType === 'WagerTransactionRejected' && e.data.externalTransactionId === 'orphan');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].data.failureCode).toBe('REFERENCE_NOT_FOUND');
    await assertWalletConsistent(walletId);
  });
});
