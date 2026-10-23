import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { Metrics } from '../../application/ports/metrics';

@Injectable()
export class PrometheusMetrics extends Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Transações finalizadas por kind/status/origem',
    labelNames: ['kind', 'status', 'source'] as const,
    registers: [this.registry],
  });
  private readonly replays = new Counter({
    name: 'wager_idempotent_replays_total',
    help: 'Duplicatas detectadas pela idempotency key',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });
  private readonly inboxDuplicates = new Counter({
    name: 'wager_inbox_duplicates_total',
    help: 'Mensagens SQS já presentes na inbox',
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'wallet_lock_conflicts_total',
    help: 'Conflitos de versão/lock na wallet que exigiram retry',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  private readonly lockWaitHist = new Histogram({
    name: 'wallet_lock_wait_seconds',
    help: 'Tempo esperando o SELECT FOR UPDATE da wallet',
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly processing = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'Latência do use case de processamento (fim a fim, inclui retries)',
    labelNames: ['source', 'kind'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly pendingRefRetries = new Counter({
    name: 'pending_reference_retries_total',
    help: 'Tentativas do worker de referências pendentes, por desfecho',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });
  private readonly outboxPublishedCounter = new Counter({
    name: 'outbox_published_total',
    help: 'Eventos publicados pelo outbox',
    registers: [this.registry],
  });
  private readonly outboxFailures = new Counter({
    name: 'outbox_publish_failures_total',
    help: 'Falhas de publicação (reagendadas com backoff)',
    registers: [this.registry],
  });
  private readonly outboxLagHist = new Histogram({
    name: 'outbox_lag_seconds',
    help: 'Tempo entre o commit do evento e sua publicação',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [this.registry],
  });
  private readonly outboxPendingGauge = new Gauge({
    name: 'outbox_pending_messages',
    help: 'Eventos ainda não publicados',
    registers: [this.registry],
  });
  private readonly outboxOldestGauge = new Gauge({
    name: 'outbox_oldest_pending_age_seconds',
    help: 'Idade do evento pendente mais antigo',
    registers: [this.registry],
  });
  private readonly sqsRetries = new Counter({
    name: 'sqs_retries_total',
    help: 'Mensagens devolvidas para a fila por erro transitório',
    registers: [this.registry],
  });
  private readonly sqsDlq = new Counter({
    name: 'sqs_dead_lettered_total',
    help: 'Mensagens enviadas para a DLQ',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  private readonly sqsAcks = new Counter({
    name: 'sqs_messages_acked_total',
    help: 'Mensagens confirmadas após commit',
    registers: [this.registry],
  });
  private readonly reconciliation = new Counter({
    name: 'wallet_reconciliation_divergences_total',
    help: 'Reconciliações que encontraram divergência',
    registers: [this.registry],
  });

  constructor() {
    super();
    collectDefaultMetrics({ register: this.registry });
  }

  transactionFinished(labels: { kind: string; status: string; source: string }): void {
    this.transactions.inc(labels);
  }
  idempotentReplay(source: string): void {
    this.replays.inc({ source });
  }
  inboxDuplicate(): void {
    this.inboxDuplicates.inc();
  }
  lockConflict(reason: string): void {
    this.lockConflicts.inc({ reason });
  }
  lockWait(seconds: number): void {
    this.lockWaitHist.observe(seconds);
  }
  processingDuration(labels: { source: string; kind: string }, seconds: number): void {
    this.processing.observe(labels, seconds);
  }
  pendingReferenceRetry(outcome: string): void {
    this.pendingRefRetries.inc({ outcome });
  }
  outboxPublished(count: number): void {
    if (count > 0) this.outboxPublishedCounter.inc(count);
  }
  outboxPublishFailed(count: number): void {
    if (count > 0) this.outboxFailures.inc(count);
  }
  outboxLag(seconds: number): void {
    this.outboxLagHist.observe(Math.max(0, seconds));
  }
  outboxPending(count: number, oldestAgeSeconds: number): void {
    this.outboxPendingGauge.set(count);
    this.outboxOldestGauge.set(Math.max(0, oldestAgeSeconds));
  }
  sqsRetry(): void {
    this.sqsRetries.inc();
  }
  sqsDeadLettered(reason: string): void {
    this.sqsDlq.inc({ reason });
  }
  sqsBusinessAck(): void {
    this.sqsAcks.inc();
  }
  reconciliationDivergence(): void {
    this.reconciliation.inc();
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
