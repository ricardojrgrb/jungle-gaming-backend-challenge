import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { Logger as Pino } from 'pino';
import { PublishOutboxUseCase } from './application/outbox/publish-outbox.use-case';
import { ClockPort, ReferenceRetryPolicyPort } from './application/ports/clock';
import { EventPublisher } from './application/ports/event-publisher';
import { AppLogger } from './application/ports/logger';
import { Metrics } from './application/ports/metrics';
import { UnitOfWork } from './application/ports/repositories';
import { GetWagerTransactionUseCase } from './application/wagering/get-wager-transaction.use-case';
import { ProcessWagerTransactionUseCase } from './application/wagering/process-wager-transaction.use-case';
import { RetryPendingReferencesUseCase } from './application/wagering/retry-pending-references.use-case';
import { OpenWalletUseCase } from './application/wallets/open-wallet.use-case';
import { ReconcileWalletUseCase } from './application/wallets/reconcile-wallet.use-case';
import { WalletQueriesUseCase } from './application/wallets/wallet-queries.use-case';
import { SystemClock } from './domain/shared/clock';
import { type AppConfig, ConfigPort, StaticConfig } from './infrastructure/config/config';
import { HealthController } from './infrastructure/health/health.controller';
import { AppExceptionFilter } from './infrastructure/http/app-exception.filter';
import { ProviderAuthGuard } from './infrastructure/http/auth/provider-auth.guard';
import { WageringController } from './infrastructure/http/controllers/wagering.controller';
import { WalletsController } from './infrastructure/http/controllers/wallets.controller';
import { correlationMiddleware } from './infrastructure/http/correlation.middleware';
import { FaultInjector } from './infrastructure/observability/fault-injection';
import { MetricsController } from './infrastructure/observability/metrics.controller';
import { PinoAppLogger, createPino } from './infrastructure/observability/pino-logger';
import { PrometheusMetrics } from './infrastructure/observability/prometheus-metrics';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { buildOrmConfig } from './infrastructure/persistence/mikro-orm.config';
import { createSqsClient } from './infrastructure/sqs/sqs-client';
import { SqsEventPublisher } from './infrastructure/sqs/sqs-event-publisher';
import { ensureQueues } from './infrastructure/sqs/sqs-setup';
import { SqsWagerConsumer } from './infrastructure/sqs/sqs-wager-consumer';
import { OutboxPublisherWorker } from './infrastructure/workers/outbox-publisher.worker';
import { PendingReferenceWorker } from './infrastructure/workers/pending-reference.worker';

export const PINO = Symbol('PINO');

/**
 * Um módulo só, com a fiação explícita. O projeto é pequeno o bastante para a
 * separação por camadas viver nas pastas (domain/application/infrastructure) e
 * não em módulos Nest; o que importa é que as portas (abstract classes) sejam
 * os tokens, e as implementações entrem aqui.
 */
@Module({})
export class AppModule implements NestModule {
  static forConfig(config: AppConfig, pino: Pino = createPino({ level: config.LOG_LEVEL, pretty: config.LOG_PRETTY, instanceId: config.INSTANCE_ID })) {
    return {
      module: AppModule,
      controllers: [WalletsController, WageringController, HealthController, MetricsController],
      providers: [
        { provide: ConfigPort, useValue: new StaticConfig(config) },
        { provide: PINO, useValue: pino },
        { provide: AppLogger, useFactory: () => new PinoAppLogger(pino) },
        { provide: ClockPort, useClass: SystemClock },
        {
          provide: ReferenceRetryPolicyPort,
          useValue: {
            policy: {
              maxAttempts: config.PENDING_REFERENCE_MAX_ATTEMPTS,
              baseDelayMs: config.PENDING_REFERENCE_BASE_DELAY_MS,
              maxDelayMs: config.PENDING_REFERENCE_MAX_DELAY_MS,
            },
          },
        },
        PrometheusMetrics,
        { provide: Metrics, useExisting: PrometheusMetrics },
        {
          provide: MikroORM,
          useFactory: async () =>
            MikroORM.init(buildOrmConfig({ clientUrl: config.DATABASE_URL, poolMax: config.DB_POOL_MAX, debug: false })),
        },
        { provide: UnitOfWork, useClass: MikroOrmUnitOfWork },
        {
          provide: SQSClient,
          useFactory: async () => {
            const client = createSqsClient(config);
            if (config.SQS_CREATE_QUEUES) {
              await ensureQueues(client, config);
            }
            return client;
          },
        },
        { provide: EventPublisher, useClass: SqsEventPublisher },
        FaultInjector,
        ProviderAuthGuard,
        ProcessWagerTransactionUseCase,
        RetryPendingReferencesUseCase,
        GetWagerTransactionUseCase,
        OpenWalletUseCase,
        WalletQueriesUseCase,
        ReconcileWalletUseCase,
        PublishOutboxUseCase,
        SqsWagerConsumer,
        OutboxPublisherWorker,
        PendingReferenceWorker,
        { provide: APP_FILTER, useFactory: (logger: AppLogger) => new AppExceptionFilter(logger), inject: [AppLogger] },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(correlationMiddleware).forRoutes('*');
  }
}
