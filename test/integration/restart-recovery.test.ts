import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ApiClient, uuid } from '../helpers/api';
import { startApp } from '../helpers/app';
import { queueUrl, testQueueNames } from '../helpers/env';
import { assertWalletConsistent, closeOrm, getOrm, outboxRows, sql, truncateAll } from '../helpers/db';
import { deleteQueues, drainQueue, waitFor } from '../helpers/sqs';

describe('recuperação após reinicialização', () => {
  const names = testQueueNames('restart');
  beforeAll(async () => {
    await getOrm();
    await truncateAll();
  });
  afterAll(async () => {
    await deleteQueues([queueUrl(names.wager), queueUrl(names.dlq), queueUrl(names.events)]);
    await closeOrm();
  });

  it('eventos pendentes no outbox e referências pendentes sobrevivem ao restart e são concluídos pela próxima instância', async () => {
    // Instância 1: sem workers. Tudo que ela faz fica "parado" no banco.
    const first = await startApp({ ENABLE_SQS_CONSUMER: 'false', ENABLE_OUTBOX_PUBLISHER: 'false', ENABLE_PENDING_REFERENCE_WORKER: 'false' }, 'restart');
    const api1 = new ApiClient(first.url);
    const playerId = uuid();
    const walletId = (await api1.createWallet(playerId, '100.00')).body.id;
    const refund = await api1.submit({ externalTransactionId: 'refund-1', playerId, walletId, kind: 'REFUND', amount: '40.00', referenceExternalTransactionId: 'bet-1' });
    expect(refund.status).toBe(202);
    const bet = await api1.submit({ externalTransactionId: 'bet-1', playerId, walletId, kind: 'BET', amount: '40.00' });
    expect(bet.status).toBe(200);
    await first.close();

    expect((await outboxRows('WHERE published_at IS NULL')).length).toBeGreaterThanOrEqual(5);
    const [pending] = await sql<{ status: string }>("SELECT status FROM wager_transactions WHERE external_transaction_id = 'refund-1'");
    expect(pending!.status).toBe('PENDING_REFERENCE');

    // Instância 2: workers ligados, mesma fila/banco.
    const second = await startApp({ ENABLE_SQS_CONSUMER: 'false' }, 'restart');
    try {
      await waitFor(async () => (await outboxRows('WHERE published_at IS NULL')).length === 0, { label: 'outbox drained' });
      await waitFor(async () => (await sql<{ status: string }>("SELECT status FROM wager_transactions WHERE external_transaction_id = 'refund-1'"))[0]?.status === 'PROCESSED', { label: 'refund resolved' });
      const events = await drainQueue(queueUrl(names.events), { maxWaitMs: 5000 });
      const types = events.map((m) => JSON.parse(m.Body!).eventType);
      expect(types).toContain('WagerTransactionPendingReference');
      expect(types.filter((t) => t === 'WagerTransactionProcessed')).toHaveLength(2);
      const api2 = new ApiClient(second.url);
      expect((await api2.get(`/wallets/${walletId}`)).body.balance.amount).toBe('100.00');
      await assertWalletConsistent(walletId);
    } finally {
      await second.close();
    }
  });
});
