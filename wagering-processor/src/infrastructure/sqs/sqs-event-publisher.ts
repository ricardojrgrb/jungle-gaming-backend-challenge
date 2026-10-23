import { Injectable } from '@nestjs/common';
import { SQSClient, SendMessageBatchCommand, type SendMessageBatchRequestEntry } from '@aws-sdk/client-sqs';
import { EventPublisher, type PublishResult } from '../../application/ports/event-publisher';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { ConfigPort } from '../config/config';

const SQS_BATCH_LIMIT = 10;

/**
 * Publica eventos do outbox na fila FIFO de eventos.
 *   MessageGroupId      = aggregateId (walletId) → ordem por wallet
 *   MessageDeduplicationId = eventId → o SQS segura duplicatas numa janela de 5 min,
 *                            mas isso é otimização; o consumidor ainda dedup pelo eventId.
 */
@Injectable()
export class SqsEventPublisher extends EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly config: ConfigPort,
  ) {
    super();
  }

  async publish(messages: OutboxMessage[]): Promise<PublishResult[]> {
    const results: PublishResult[] = [];
    for (let i = 0; i < messages.length; i += SQS_BATCH_LIMIT) {
      const chunk = messages.slice(i, i + SQS_BATCH_LIMIT);
      results.push(...(await this.publishChunk(chunk)));
    }
    return results;
  }

  private async publishChunk(chunk: OutboxMessage[]): Promise<PublishResult[]> {
    const entries: SendMessageBatchRequestEntry[] = chunk.map((m, idx) => ({
      Id: String(idx),
      MessageBody: JSON.stringify(m.payload),
      MessageGroupId: m.aggregateId,
      MessageDeduplicationId: m.id,
      MessageAttributes: {
        eventType: { DataType: 'String', StringValue: m.eventType },
        eventId: { DataType: 'String', StringValue: m.id },
      },
    }));

    try {
      const response = await this.sqs.send(
        new SendMessageBatchCommand({ QueueUrl: this.config.values.SQS_EVENTS_QUEUE_URL, Entries: entries }),
      );
      const failed = new Map((response.Failed ?? []).map((f) => [f.Id, f]));
      return chunk.map((m, idx) => {
        const failure = failed.get(String(idx));
        return failure
          ? { messageId: m.id, error: new Error(`${failure.Code ?? 'SQS_ERROR'}: ${failure.Message ?? 'batch entry failed'}`) }
          : { messageId: m.id };
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return chunk.map((m) => ({ messageId: m.id, error: err }));
    }
  }
}
