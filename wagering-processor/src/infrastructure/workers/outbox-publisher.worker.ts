import { type BeforeApplicationShutdown, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { PublishOutboxUseCase } from '../../application/outbox/publish-outbox.use-case';
import { AppLogger } from '../../application/ports/logger';
import { ConfigPort } from '../config/config';
import { IntervalLoop } from './interval-loop';

const STATS_EVERY_MS = 5_000;

@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: IntervalLoop;
  private lastStatsAt = 0;

  constructor(
    private readonly useCase: PublishOutboxUseCase,
    private readonly config: ConfigPort,
    private readonly logger: AppLogger,
  ) {
    this.loop = new IntervalLoop('outbox-publisher', () => this.tick(), config.values.OUTBOX_POLL_INTERVAL_MS, logger);
  }

  onApplicationBootstrap(): void {
    if (this.config.values.ENABLE_OUTBOX_PUBLISHER) {
      this.loop.start();
      this.logger.info({ intervalMs: this.config.values.OUTBOX_POLL_INTERVAL_MS }, 'outbox publisher started');
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }

  poke(): void {
    this.loop.poke();
  }

  private async tick(): Promise<boolean> {
    const report = await this.useCase.runOnce();
    const now = Date.now();
    if (now - this.lastStatsAt > STATS_EVERY_MS) {
      this.lastStatsAt = now;
      await this.useCase.refreshStats();
    }
    // Lote cheio → provavelmente tem mais; não espera o intervalo.
    return report.claimed > 0 && report.failed === 0;
  }
}
