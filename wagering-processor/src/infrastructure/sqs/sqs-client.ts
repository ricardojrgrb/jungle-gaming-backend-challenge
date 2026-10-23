import { SQSClient } from '@aws-sdk/client-sqs';
import { type AppConfig } from '../config/config';

export function createSqsClient(config: AppConfig): SQSClient {
  return new SQSClient({
    region: config.AWS_REGION,
    ...(config.SQS_ENDPOINT ? { endpoint: config.SQS_ENDPOINT } : {}),
    credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY },
    // Fail fast: o broker fora do ar vira erro transitório rápido, não request pendurado.
    requestHandler: { requestTimeout: 10_000, connectionTimeout: 3_000 },
    maxAttempts: 2,
  });
}
