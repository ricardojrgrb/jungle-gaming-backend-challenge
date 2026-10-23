/**
 * Métricas que a aplicação emite. A implementação Prometheus fica na infra;
 * aqui é só o vocabulário, para os use cases não dependerem do prom-client.
 */
export abstract class Metrics {
  abstract transactionFinished(labels: { kind: string; status: string; source: string }): void;
  abstract idempotentReplay(source: string): void;
  abstract inboxDuplicate(): void;
  abstract lockConflict(reason: string): void;
  abstract lockWait(seconds: number): void;
  abstract processingDuration(labels: { source: string; kind: string }, seconds: number): void;
  abstract pendingReferenceRetry(outcome: string): void;
  abstract outboxPublished(count: number): void;
  abstract outboxPublishFailed(count: number): void;
  abstract outboxLag(seconds: number): void;
  abstract outboxPending(count: number, oldestAgeSeconds: number): void;
  abstract sqsRetry(): void;
  abstract sqsDeadLettered(reason: string): void;
  abstract sqsBusinessAck(): void;
  abstract reconciliationDivergence(): void;
}

export class NoopMetrics extends Metrics {
  transactionFinished(): void {}
  idempotentReplay(): void {}
  inboxDuplicate(): void {}
  lockConflict(): void {}
  lockWait(): void {}
  processingDuration(): void {}
  pendingReferenceRetry(): void {}
  outboxPublished(): void {}
  outboxPublishFailed(): void {}
  outboxLag(): void {}
  outboxPending(): void {}
  sqsRetry(): void {}
  sqsDeadLettered(): void {}
  sqsBusinessAck(): void {}
  reconciliationDivergence(): void {}
}
