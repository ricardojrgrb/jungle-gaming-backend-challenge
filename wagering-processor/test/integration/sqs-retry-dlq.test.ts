import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { NoopLogger } from '../../src/application/ports/logger';
import { TransientInfrastructureError } from '../../src/application/shared/errors';
import type { ProcessWagerTransactionUseCase } from '../../src/application/wagering/process-wager-transaction.use-case';
import type { BootstrappedApp } from '../../src/bootstrap';
import { StaticConfig } from '../../src/infrastructure/config/config';
import { FaultInjector } from '../../src/infrastructure/observability/fault-injection';
import { PrometheusMetrics } from '../../src/infrastructure/observability/prometheus-metrics';
import { ensureQueues } from '../../src/infrastructure/sqs/sqs-setup';
import { SqsWagerConsumer } from '../../src/infrastructure/sqs/sqs-wager-consumer';
import { ApiClient, uuid } from '../helpers/api';
import { startApp } from '../helpers/app';
import { queueUrl, testConfig, testQueueNames } from '../helpers/env';
import { closeOrm, getOrm, sql, truncateAll } from '../helpers/db';
import { deleteQueues, drainQueue, queueDepth, sendRawMessage, sendWagerMessage, sqs, waitFor } from '../helpers/sqs';

describe('SQS: erros de negócio, transitórios e permanentes', () => {
  const names = testQueueNames('dlq');
  let app: BootstrappedApp;
  let api: ApiClient;

  beforeAll(async () => {
    await getOrm();
    await truncateAll();
    app = await startApp({ SQS_MAX_RECEIVE_COUNT: '2', ENABLE_PENDING_REFERENCE_WORKER: 'false' }, 'dlq');
    api = new ApiClient(app.url);
  });
  afterAll(async () => {
    await app.close();
    await deleteQueues([queueUrl(names.wager), queueUrl(names.dlq), queueUrl(names.events)]);
    await closeOrm();
  });

  it('erro de negócio é terminal: vira REJECTED no banco e a mensagem recebe ack', async () => {
    const playerId = uuid();
    const walletId = (await api.createWallet(playerId, '10.00')).body.id;
    await sendWagerMessage(queueUrl(names.wager), { messageId: 'biz-1', providerId: 'provider-a', externalTransactionId: 'biz-1', playerId, walletId, roundId: 'r', kind: 'BET', amount: '99.00' });
    const tx = await waitFor(async () => (await sql<{ status: string; failure_code: string }>("SELECT status, failure_code FROM wager_transactions WHERE external_transaction_id = 'biz-1'"))[0], { label: 'rejected tx' });
    expect(tx).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    await waitFor(async () => {
      const d = await queueDepth(queueUrl(names.wager));
      return d.visible === 0 && d.inFlight === 0;
    });
    expect((await queueDepth(queueUrl(names.dlq))).visible).toBe(0);
  });

  it('mensagem malformada e wallet inexistente vão direto para a DLQ com o motivo', async () => {
    await sendRawMessage(queueUrl(names.wager), '{"this is": "not a wager"}');
    await sendRawMessage(queueUrl(names.wager), 'not even json');
    await sendWagerMessage(queueUrl(names.wager), { messageId: 'nowallet', providerId: 'provider-a', externalTransactionId: 'nowallet', playerId: uuid(), walletId: uuid(), roundId: 'r', kind: 'BET', amount: '1.00' });
    await sendWagerMessage(queueUrl(names.wager), { messageId: 'opening', providerId: 'provider-a', externalTransactionId: 'opening', playerId: uuid(), walletId: uuid(), roundId: 'r', kind: 'OPENING', amount: '1.00' });

    const dead = await drainQueue(queueUrl(names.dlq), { expected: 4, maxWaitMs: 15000 });
    const reasons = dead.map((m) => m.MessageAttributes?.failureReason?.StringValue).sort();
    expect(reasons).toEqual(['INVALID_MESSAGE', 'INVALID_MESSAGE', 'INVALID_MESSAGE', 'WALLET_NOT_FOUND']);
    expect(dead.every((m) => m.MessageAttributes?.failureDetail?.StringValue)).toBe(true);
    const metrics = await fetch(`${app.url}/metrics`).then((r) => r.text());
    expect(metrics).toMatch(/sqs_dead_lettered_total\{reason="INVALID_MESSAGE"\} 3/);
    expect(metrics).toMatch(/sqs_dead_lettered_total\{reason="WALLET_NOT_FOUND"\} 1/);
  });

  it('erro transitório: devolve com backoff, respeita o limite de tentativas e então DLQ', async () => {
    // Consumidor próprio com um use case que simula banco fora do ar.
    const config = testConfig({ SQS_MAX_RECEIVE_COUNT: '2', SQS_WAIT_TIME_SECONDS: '1', SQS_VISIBILITY_TIMEOUT_SECONDS: '5', SQS_CONSUMER_NAME: 'flaky' }, 'flaky');
    const flakyNames = testQueueNames('flaky');
    await ensureQueues(sqs, config);
    let calls = 0;
    const useCase = {
      execute: async () => {
        calls++;
        throw new TransientInfrastructureError('postgres unreachable (simulated)');
      },
    } as unknown as ProcessWagerTransactionUseCase;
    const metrics = new PrometheusMetrics();
    const cfg = new StaticConfig(config);
    const consumer = new SqsWagerConsumer(sqs, cfg, useCase, metrics, new FaultInjector(cfg), new NoopLogger());
    consumer.start();
    try {
      const walletId = uuid();
      const started = Date.now();
      await sendWagerMessage(queueUrl(flakyNames.wager), { messageId: 'flaky-1', providerId: 'provider-a', externalTransactionId: 'flaky-1', playerId: uuid(), walletId, roundId: 'r', kind: 'BET', amount: '1.00' });
      const dead = await drainQueue(queueUrl(flakyNames.dlq), { expected: 1, maxWaitMs: 20000 });
      const elapsed = Date.now() - started;
      expect(dead).toHaveLength(1);
      expect(dead[0]!.MessageAttributes?.failureReason?.StringValue).toBe('RETRIES_EXHAUSTED');
      expect(calls).toBe(2);
      // 1ª tentativa falha → visibility 2^1 = 2s → 2ª tentativa → limite → DLQ
      expect(elapsed).toBeGreaterThanOrEqual(1900);
      const text = await metrics.render();
      expect(text).toMatch(/sqs_retries_total 1/);
      expect(text).toMatch(/sqs_dead_lettered_total\{reason="RETRIES_EXHAUSTED"\} 1/);
      expect((await queueDepth(queueUrl(flakyNames.wager))).visible).toBe(0);
    } finally {
      await consumer.stop();
      await deleteQueues([queueUrl(flakyNames.wager), queueUrl(flakyNames.dlq), queueUrl(flakyNames.events)]);
    }
  });

  it('SIGTERM: para de receber e devolve a visibilidade das mensagens em andamento', async () => {
    const config = testConfig({ SQS_WAIT_TIME_SECONDS: '1', SQS_VISIBILITY_TIMEOUT_SECONDS: '30', SHUTDOWN_GRACE_MS: '300', SQS_CONSUMER_NAME: 'slow' }, 'slow');
    const slowNames = testQueueNames('slow');
    await ensureQueues(sqs, config);
    let release: () => void = () => {};
    const useCase = {
      execute: () => new Promise((resolve) => { release = () => resolve({ type: 'duplicate_message' }); }),
    } as unknown as ProcessWagerTransactionUseCase;
    const cfg = new StaticConfig(config);
    const consumer = new SqsWagerConsumer(sqs, cfg, useCase, new PrometheusMetrics(), new FaultInjector(cfg), new NoopLogger());
    consumer.start();
    try {
      await sendWagerMessage(queueUrl(slowNames.wager), { messageId: 'slow-1', providerId: 'provider-a', externalTransactionId: 'slow-1', playerId: uuid(), walletId: uuid(), roundId: 'r', kind: 'BET', amount: '1.00' });
      await waitFor(async () => (await queueDepth(queueUrl(slowNames.wager))).inFlight === 1, { label: 'message in flight' });
      // SIGTERM com a mensagem travada no use case: grace de 300ms expira e a visibilidade é zerada
      await consumer.stop('SIGTERM');
      const depth = await waitFor(async () => {
        const d = await queueDepth(queueUrl(slowNames.wager));
        return d.visible === 1 ? d : null;
      }, { label: 'message visible again', timeoutMs: 5000 });
      expect(depth.visible).toBe(1);
      release();
    } finally {
      release();
      await deleteQueues([queueUrl(slowNames.wager), queueUrl(slowNames.dlq), queueUrl(slowNames.events)]);
    }
  });
});
