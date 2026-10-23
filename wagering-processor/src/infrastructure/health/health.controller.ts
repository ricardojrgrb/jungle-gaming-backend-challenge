import { Controller, Get, Res } from '@nestjs/common';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { Response } from 'express';
import { ConfigPort } from '../config/config';

const CHECK_TIMEOUT_MS = 2_000;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Abertos (sem guard): o orquestrador precisa bater aqui sem token. */
@Controller('health')
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly config: ConfigPort,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok', instanceId: this.config.values.INSTANCE_ID, uptimeSeconds: Math.round(process.uptime()) };
  }

  @Get('ready')
  async ready(@Res() res: Response) {
    const checks: Record<string, { status: 'up' | 'down'; error?: string }> = {};

    try {
      await withTimeout(this.orm.em.fork({ useContext: false }).execute('SELECT 1'), CHECK_TIMEOUT_MS);
      checks.postgres = { status: 'up' };
    } catch (error) {
      checks.postgres = { status: 'down', error: (error as Error).message };
    }

    try {
      await withTimeout(
        this.sqs.send(
          new GetQueueAttributesCommand({ QueueUrl: this.config.values.SQS_WAGER_QUEUE_URL, AttributeNames: ['QueueArn'] }),
        ),
        CHECK_TIMEOUT_MS,
      );
      checks.sqs = { status: 'up' };
    } catch (error) {
      checks.sqs = { status: 'down', error: (error as Error).message };
    }

    const ready = Object.values(checks).every((c) => c.status === 'up');
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
  }
}
