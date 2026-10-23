import { bootstrap } from './bootstrap';
import { loadConfig } from './infrastructure/config/config';

const config = loadConfig();
const { pino, url } = await bootstrap(config);
pino.info(
  {
    url,
    instanceId: config.INSTANCE_ID,
    consumer: config.ENABLE_SQS_CONSUMER,
    outbox: config.ENABLE_OUTBOX_PUBLISHER,
    pendingReferences: config.ENABLE_PENDING_REFERENCE_WORKER,
    auth: config.AUTH_MODE,
  },
  'wagering-processor up',
);
