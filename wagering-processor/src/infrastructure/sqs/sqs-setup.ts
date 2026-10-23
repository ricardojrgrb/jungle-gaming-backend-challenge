import { CreateQueueCommand, GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { type AppConfig } from '../config/config';

function queueNameFromUrl(url: string): string {
  return url.split('/').pop() ?? url;
}

/**
 * CreateQueue só é idempotente com atributos idênticos. Se a fila já existe com
 * outros atributos (ex.: visibility diferente), seguimos em frente: o consumidor
 * passa o VisibilityTimeout por ReceiveMessage, e a redrive policy já está lá.
 */
async function createOrReuse(sqs: SQSClient, input: ConstructorParameters<typeof CreateQueueCommand>[0]): Promise<string> {
  try {
    const res = await sqs.send(new CreateQueueCommand(input));
    return res.QueueUrl!;
  } catch (error) {
    if ((error as { name?: string }).name === 'QueueNameExists') {
      const res = await sqs.send(new GetQueueUrlCommand({ QueueName: input.QueueName! }));
      return res.QueueUrl!;
    }
    throw error;
  }
}

/**
 * Cria as filas se não existirem. Em produção elas vêm do Terraform/compose; nos
 * testes cada suíte usa filas próprias e precisa criá-las. CreateQueue é
 * idempotente para os mesmos atributos.
 */
export async function ensureQueues(sqs: SQSClient, config: AppConfig): Promise<void> {
  const dlqName = queueNameFromUrl(config.SQS_WAGER_DLQ_URL);
  const dlqUrl = await createOrReuse(sqs, {
    QueueName: dlqName,
    Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', MessageRetentionPeriod: '1209600' },
  });
  const attrs = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }));
  const dlqArn = attrs.Attributes?.QueueArn;

  await createOrReuse(sqs, {
    QueueName: queueNameFromUrl(config.SQS_WAGER_QUEUE_URL),
    Attributes: {
      FifoQueue: 'true',
      ContentBasedDeduplication: 'false',
      VisibilityTimeout: String(config.SQS_VISIBILITY_TIMEOUT_SECONDS),
      ...(dlqArn
        ? { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: String(config.SQS_MAX_RECEIVE_COUNT) }) }
        : {}),
    },
  });
  await createOrReuse(sqs, {
    QueueName: queueNameFromUrl(config.SQS_EVENTS_QUEUE_URL),
    Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
  });
}
