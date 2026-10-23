import { type AppConfig, loadConfig } from '../../src/infrastructure/config/config';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL!;
export const TEST_SQS_ENDPOINT = process.env.TEST_SQS_ENDPOINT!;

/** Sufixo único por execução: cada rodada de testes fala com filas próprias. */
export const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function queueUrl(name: string): string {
  return `${TEST_SQS_ENDPOINT}/000000000000/${name}`;
}

export function testQueueNames(tag = 'main') {
  return {
    wager: `wager-tx-${RUN_ID}-${tag}.fifo`,
    dlq: `wager-tx-dlq-${RUN_ID}-${tag}.fifo`,
    events: `wager-ev-${RUN_ID}-${tag}.fifo`,
  };
}

export function testEnv(overrides: Record<string, string> = {}, tag = 'main'): Record<string, string> {
  const names = testQueueNames(tag);
  return {
    NODE_ENV: 'test',
    PORT: '0',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent',
    DATABASE_URL: TEST_DATABASE_URL,
    DB_POOL_MAX: '10',
    SQS_ENDPOINT: TEST_SQS_ENDPOINT,
    SQS_WAGER_QUEUE_URL: queueUrl(names.wager),
    SQS_WAGER_DLQ_URL: queueUrl(names.dlq),
    SQS_EVENTS_QUEUE_URL: queueUrl(names.events),
    SQS_CREATE_QUEUES: 'true',
    SQS_WAIT_TIME_SECONDS: '1',
    SQS_VISIBILITY_TIMEOUT_SECONDS: '5',
    OUTBOX_POLL_INTERVAL_MS: '100',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '100',
    PENDING_REFERENCE_BASE_DELAY_MS: '100',
    PENDING_REFERENCE_MAX_DELAY_MS: '500',
    SHUTDOWN_GRACE_MS: '5000',
    AUTH_MODE: 'none',
    ...overrides,
  };
}

export function testConfig(overrides: Record<string, string> = {}, tag = 'main'): AppConfig {
  return loadConfig(testEnv(overrides, tag));
}
