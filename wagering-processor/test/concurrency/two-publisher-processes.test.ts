import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnApp } from '../helpers/app';
import { queueUrl, testQueueNames } from '../helpers/env';
import { closeOrm, getOrm, outboxRows, sql, truncateAll } from '../helpers/db';
import { deleteQueues, drainQueue, waitFor } from '../helpers/sqs';

describe('dois publishers (processos separados) sobre a mesma outbox', () => {
  const names = testQueueNames('pub2');
  beforeAll(async () => {
    await getOrm();
    await truncateAll();
  });
  afterAll(async () => {
    await deleteQueues([queueUrl(names.wager), queueUrl(names.dlq), queueUrl(names.events)]);
    await closeOrm();
  });

  it('500 eventos pendentes: cada um publicado uma vez, pelos dois processos', async () => {
    const ids: string[] = [];
    const now = new Date();
    const values: string[] = [];
    const params: unknown[] = [];
    for (let i = 0; i < 500; i++) {
      const id = crypto.randomUUID();
      const agg = crypto.randomUUID();
      ids.push(id);
      values.push('(?, ?, ?, ?, ?, 0, ?)');
      params.push(id, agg, 'TestEvent', JSON.stringify({ eventId: id, eventType: 'TestEvent', aggregateId: agg, version: 1, data: { i } }), now, now);
    }
    await sql(`INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, created_at) VALUES ${values.join(',')}`, params);

    const flags = { ENABLE_SQS_CONSUMER: 'false', ENABLE_PENDING_REFERENCE_WORKER: 'false', OUTBOX_POLL_INTERVAL_MS: '50' };
    const [p1, p2] = await Promise.all([spawnApp(flags, 'pub2'), spawnApp(flags, 'pub2')]);
    try {
      await waitFor(async () => (await outboxRows('WHERE published_at IS NULL')).length === 0, { timeoutMs: 60000, label: 'outbox drained' });
      const published = (text: string) => Number(/outbox_published_total (\d+)/.exec(text)?.[1] ?? 0);
      const [m1, m2] = await Promise.all([fetch(`${p1.url}/metrics`).then((r) => r.text()), fetch(`${p2.url}/metrics`).then((r) => r.text())]);
      expect(published(m1) + published(m2)).toBe(500);
      expect(published(m1)).toBeGreaterThan(0);
      expect(published(m2)).toBeGreaterThan(0);
      console.log(`publisher 1: ${published(m1)}, publisher 2: ${published(m2)}`);
    } finally {
      await Promise.all([p1.stop(), p2.stop()]);
    }
    const received = await drainQueue(queueUrl(names.events), { expected: 500, maxWaitMs: 30000 });
    const receivedIds = received.map((m) => JSON.parse(m.Body!).eventId);
    expect(receivedIds).toHaveLength(500);
    expect(new Set(receivedIds)).toEqual(new Set(ids));
  });
});
