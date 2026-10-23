import { type BeforeApplicationShutdown, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { AppLogger } from '../../application/ports/logger';
import { RetryPendingReferencesUseCase } from '../../application/wagering/retry-pending-references.use-case';
import { ConfigPort } from '../config/config';
import { IntervalLoop } from './interval-loop';

@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: IntervalLoop;

  constructor(
    private readonly useCase: RetryPendingReferencesUseCase,
    private readonly config: ConfigPort,
    private readonly logger: AppLogger,
  ) {
    this.loop = new IntervalLoop(
      'pending-reference',
      () => this.tick(),
      config.values.PENDING_REFERENCE_POLL_INTERVAL_MS,
      logger,
    );
  }

  onApplicationBootstrap(): void {
    if (this.config.values.ENABLE_PENDING_REFERENCE_WORKER) {
      this.loop.start();
      this.logger.info({ intervalMs: this.config.values.PENDING_REFERENCE_POLL_INTERVAL_MS }, 'pending-reference worker started');
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
    if (report.claimed > 0) {
      this.logger.info({ ...report }, 'pending-reference round');
    }
    return report.claimed > 0;
  }
}
