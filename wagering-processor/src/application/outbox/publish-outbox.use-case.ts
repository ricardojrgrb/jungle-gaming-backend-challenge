import { Injectable } from '@nestjs/common';
import { ClockPort } from '../ports/clock';
import { EventPublisher } from '../ports/event-publisher';
import { AppLogger } from '../ports/logger';
import { Metrics } from '../ports/metrics';
import { UnitOfWork } from '../ports/repositories';

const BATCH = 50;

export interface PublishOutboxReport {
  claimed: number;
  published: number;
  failed: number;
}

/**
 * Publisher do outbox. Em cada rodada:
 *   claim (FOR UPDATE SKIP LOCKED) → publica → marca publicado / agenda retry → commit.
 *
 * O lock de linha fica seguro durante a chamada ao SQS, de propósito: se o processo
 * morrer depois de publicar e antes de commitar, a linha volta a ficar pendente e
 * outra instância publica de novo. Isso é o at-least-once combinado: o consumidor
 * deduplica pelo eventId. Perder evento é inaceitável; duplicar, não.
 */
@Injectable()
export class PublishOutboxUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: ClockPort,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  async runOnce(): Promise<PublishOutboxReport> {
    return this.uow.run(async (repos) => {
      const now = this.clock.now();
      const batch = await repos.outbox.claimDue(now, BATCH);
      if (batch.length === 0) {
        return { claimed: 0, published: 0, failed: 0 };
      }

      const results = await this.publisher.publish(batch);
      const byId = new Map(results.map((r) => [r.messageId, r]));
      let published = 0;
      let failed = 0;

      for (const message of batch) {
        const result = byId.get(message.id);
        const publishedAt = this.clock.now();
        if (result && !result.error) {
          message.markPublished(publishedAt);
          published++;
          this.metrics.outboxLag((publishedAt.getTime() - message.occurredAt.getTime()) / 1000);
        } else {
          message.scheduleRetry(publishedAt);
          failed++;
          this.logger.warn(
            { outboxId: message.id, eventType: message.eventType, attempts: message.attempts, error: result?.error?.message },
            'outbox publish failed, scheduled retry',
          );
        }
        await repos.outbox.update(message);
      }

      this.metrics.outboxPublished(published);
      this.metrics.outboxPublishFailed(failed);
      return { claimed: batch.length, published, failed };
    });
  }

  /** Alimenta os gauges de backlog; roda com menos frequência que o publish. */
  async refreshStats(): Promise<void> {
    const stats = await this.uow.read((repos) => repos.outbox.stats());
    const oldestAge = stats.oldestPendingOccurredAt
      ? (this.clock.now().getTime() - stats.oldestPendingOccurredAt.getTime()) / 1000
      : 0;
    this.metrics.outboxPending(stats.pending, oldestAge);
  }
}
