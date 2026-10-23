import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === undefined || v === '' ? undefined : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  INSTANCE_ID: z.string().default(() => `inst-${process.pid}`),
  PORT: z.coerce.number().int().min(0).default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  LOG_PRETTY: bool.default(false),

  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: z.coerce.number().int().min(1).default(10),

  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().default('test'),
  SQS_ENDPOINT: z.string().url().optional(),
  SQS_WAGER_QUEUE_URL: z.string().url(),
  SQS_WAGER_DLQ_URL: z.string().url(),
  SQS_EVENTS_QUEUE_URL: z.string().url(),
  SQS_MAX_RECEIVE_COUNT: z.coerce.number().int().min(1).default(5),
  SQS_VISIBILITY_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(30),
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
  SQS_CONSUMER_NAME: z.string().default('wager-transactions-consumer'),
  /** Testes criam filas próprias; em produção elas já existem. */
  SQS_CREATE_QUEUES: bool.default(false),

  ENABLE_SQS_CONSUMER: bool.default(true),
  ENABLE_OUTBOX_PUBLISHER: bool.default(true),
  ENABLE_PENDING_REFERENCE_WORKER: bool.default(true),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(500),
  PENDING_REFERENCE_POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(1000),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(20_000),
  // Backoff das referências fora de ordem (ver domain/wagering/reference-retry-policy.ts).
  PENDING_REFERENCE_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(8),
  PENDING_REFERENCE_BASE_DELAY_MS: z.coerce.number().int().min(1).default(5_000),
  PENDING_REFERENCE_MAX_DELAY_MS: z.coerce.number().int().min(1).default(300_000),

  AUTH_MODE: z.enum(['none', 'oidc']).default('none'),
  AUTH_ISSUER: z.string().url().optional(),
  AUTH_JWKS_URL: z.string().url().optional(),
  AUTH_AUDIENCE: z.string().optional(),
  /** Claim do token que identifica o provedor (Keycloak: azp = client id). */
  AUTH_PROVIDER_CLAIM: z.string().default('azp'),

  /**
   * Só para testes de falha. Formato: "<ponto>" — ex.: "sqs:after-commit-before-ack".
   * Em produção isso simplesmente não é setado.
   */
  FAULT_INJECTION: z.string().optional(),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid configuration: ${issues}`);
  }
  const config = parsed.data;
  if (config.AUTH_MODE === 'oidc' && (!config.AUTH_ISSUER || !config.AUTH_JWKS_URL)) {
    throw new Error('AUTH_MODE=oidc requires AUTH_ISSUER and AUTH_JWKS_URL');
  }
  return config;
}

/** Token de injeção para a configuração. */
export abstract class ConfigPort {
  abstract readonly values: AppConfig;
}

export class StaticConfig extends ConfigPort {
  constructor(readonly values: AppConfig) {
    super();
  }
}
