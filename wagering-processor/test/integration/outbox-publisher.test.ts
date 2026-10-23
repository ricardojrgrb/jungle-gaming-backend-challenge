import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { PublishOutboxUseCase } from '../../src/application/outbox/publish-outbox.use-case';
import { EventPublisher, type PublishResult } from '../../src/application/ports/event-publisher';
import { NoopLogger } from '../../src/application/ports/logger';
import { NoopMetrics } from '../../src/application/ports/metrics';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { SystemClock } from '../../src/domain/shared/clock';
import { StaticConfig } from '../../src/infrastructure/config/config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SqsEventPublisher } from '../../src/infrastructure/sqs/sqs-event-publisher';
import { ensureQueues } from '../../src/infrastructure/sqs/sqs-setup';
import { queueUrl, testConfig, testQueueNames } from '../helpers/env';
import { closeOrm, getOrm, outboxRows, sql, truncateAll } from '../helpers/db';
import { deleteQueues, drainQueue, sqs } from '../helpers/sqs';

async function seedOutbox(n: number): Promise<string[]> {
  const ids: string[] = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const id = crypto.randomUUID();
    ids.push(id);
    const aggregateId = crypto.randomUUID();
    await sql('INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)', [
      id, aggregateId, 'TestEvent', JSON.stringify({ eventId: id, eventType: 'TestEvent', aggregateId, version: 1, data: { i } }), now, now,
    ]);
  }
  return ids;
}

describe('outbox publisher', () => {
  const names = testQueueNames('outbox');
  const config = testConfig({}, 'outbox');
  let uow: MikroOrmUnitOfWork;
  let publisher: SqsEventPublisher;

  beforeAll(async () => {
    uow = new MikroOrmUnitOfWork(await getOrm());
    await truncateAll();
    await ensureQueues(sqs, config);
    publisher = new SqsEventPublisher(sqs, new StaticConfig(config));
  });
  afterAll(async () => {
    await deleteQueues([queueUrl(names.wager), queueUrl(names.dlq), queueUrl(names.events)]);
    await closeOrm();
  });

  it('dois publishers concorrentes sobre a mesma outbox: cada evento publicado exatamente uma vez', async () => {
    const ids = await seedOutbox(237);
    const mk = () => new PublishOutboxUseCase(uow, publisher, new SystemClock(), new NoopMetrics(), new NoopLogger());
    const a = mk();
    const b = mk();
    const totals = { a: 0, b: 0 };
    const drain = async (uc: PublishOutboxUseCase, key: 'a' | 'b') => {
      for (;;) {
        const r = await uc.runOnce();
        totals[key] += r.published;
        if (r.claimed === 0) {
          // confere mais uma vez: o outro pode ter liberado linhas por falha
          const again = await uc.runOnce();
          totals[key] += again.published;
          if (again.claimed === 0) return;
        }
      }
    };
    await Promise.all([drain(a, 'a'), drain(b, 'b')]);

    expect(totals.a + totals.b).toBe(237);
    expect(totals.a).toBeGreaterThan(0);
    expect(totals.b).toBeGreaterThan(0);
    const pending = await outboxRows('WHERE published_at IS NULL');
    expect(pending).toHaveLength(0);

    const received = await drainQueue(queueUrl(names.events), { expected: 237, maxWaitMs: 15000 });
    const receivedIds = received.map((m) => JSON.parse(m.Body!).eventId);
    expect(new Set(receivedIds).size).toBe(237);
    expect(new Set(receivedIds)).toEqual(new Set(ids));
  });

  it('processo morre depois de publicar e antes do commit: a linha volta e é republicada (duplicata segura)', async () => {
    await truncateAll();
    const [id] = await seedOutbox(1);
    let crashOnce = true;
    class CrashingPublisher extends EventPublisher {
      async publish(messages: OutboxMessage[]): Promise<PublishResult[]> {
        const results = await publisher.publish(messages);
        if (crashOnce) {
          crashOnce = false;
          throw new Error('simulated crash after publish, before commit');
        }
        return results;
      }
    }
    const uc = new PublishOutboxUseCase(uow, new CrashingPublisher(), new SystemClock(), new NoopMetrics(), new NoopLogger());
    await expect(uc.runOnce()).rejects.toThrow('simulated crash');
    // transação desfeita → continua pendente, sem tentativas contadas
    expect((await outboxRows('WHERE published_at IS NULL')).map((r) => r.id)).toEqual([id!]);

    const second = await uc.runOnce();
    expect(second).toEqual({ claimed: 1, published: 1, failed: 0 });
    expect(await outboxRows('WHERE published_at IS NULL')).toHaveLength(0);

    // A fila FIFO recebeu o mesmo eventId duas vezes; o SQS colapsa pelo
    // MessageDeduplicationId e, se não colapsasse, o consumidor dedupa pelo eventId.
    const received = await drainQueue(queueUrl(names.events), { maxWaitMs: 4000 });
    const ids = received.map((m) => JSON.parse(m.Body!).eventId);
    expect(ids.every((x) => x === id)).toBe(true);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(ids.length).toBeLessThanOrEqual(2);
  });

  it('falha de publicação agenda retry com backoff e não perde o evento', async () => {
    await truncateAll();
    const [id] = await seedOutbox(1);
    class FailingPublisher extends EventPublisher {
      async publish(messages: OutboxMessage[]): Promise<PublishResult[]> {
        return messages.map((m) => ({ messageId: m.id, error: new Error('SQS down') }));
      }
    }
    const metrics = new NoopMetrics();
    const failing = new PublishOutboxUseCase(uow, new FailingPublisher(), new SystemClock(), metrics, new NoopLogger());
    expect(await failing.runOnce()).toEqual({ claimed: 1, published: 0, failed: 1 });
    const [row] = await outboxRows();
    expect(row!.attempts).toBe(1);
    expect(row!.published_at).toBeNull();
    // ainda não venceu o backoff → ninguém pega
    const healthy = new PublishOutboxUseCase(uow, publisher, new SystemClock(), metrics, new NoopLogger());
    expect((await healthy.runOnce()).claimed).toBe(0);
    await sql("UPDATE outbox_messages SET next_attempt_at = now() - interval '1 second' WHERE id = ?", [id]);
    expect(await healthy.runOnce()).toEqual({ claimed: 1, published: 1, failed: 0 });
  });
});
