import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import type { Logger as Pino } from 'pino';
import { AppModule } from './app.module';
import { type AppConfig } from './infrastructure/config/config';
import { NestPinoAdapter, createPino } from './infrastructure/observability/pino-logger';

export interface BootstrappedApp {
  app: INestApplication;
  pino: Pino;
  url: string;
  close(): Promise<void>;
}

/**
 * Sobe a aplicação completa (HTTP + consumidor + workers conforme as flags).
 * Usado pelo main.ts e pelos testes, que sobem instâncias em processo ou em
 * processos separados.
 */
export async function bootstrap(config: AppConfig): Promise<BootstrappedApp> {
  const pino = createPino({ level: config.LOG_LEVEL, pretty: config.LOG_PRETTY, instanceId: config.INSTANCE_ID });
  const app = await NestFactory.create(AppModule.forConfig(config, pino), {
    logger: new NestPinoAdapter(pino),
    bodyParser: true,
  });
  app.enableShutdownHooks();
  await app.listen(config.PORT, '0.0.0.0');
  const url = (await app.getUrl()).replace('[::1]', '127.0.0.1').replace('0.0.0.0', '127.0.0.1');

  return {
    app,
    pino,
    url,
    close: async () => {
      await app.close();
      await app.get(MikroORM).close(true);
    },
  };
}
