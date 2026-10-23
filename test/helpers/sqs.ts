import {
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { TEST_SQS_ENDPOINT } from './env';

export const sqs = new SQSClient({
  region: 'us-east-1',
  endpoint: TEST_SQS_ENDPOINT,
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

export interface WagerMessageInput {
  messageId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey?: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId?: string;
  kind: string;
  amount: string;
  currency?: string;
  referenceExternalTransactionId?: string;
}

export function wagerMessageBody(input: WagerMessageInput): string {
  return JSON.stringify({
    messageId: input.messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey ?? `${input.providerId}:${input.externalTransactionId}`,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId ?? 'fortune-chimp',
      kind: input.kind,
      money: { amount: input.amount, currency: input.currency ?? 'BRL' },
      ...(input.referenceExternalTransactionId ? { referenceExternalTransactionId: input.referenceExternalTransactionId } : {}),
    },
  });
}

/** Envia uma mensagem de aposta; dedup id único para o SQS não colapsar reenvios de teste. */
export async function sendWagerMessage(queueUrl: string, input: WagerMessageInput, groupId?: string): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: wagerMessageBody(input),
      MessageGroupId: groupId ?? input.walletId,
      MessageDeduplicationId: `${input.messageId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }),
  );
}

export async function sendRawMessage(queueUrl: string, body: string, groupId = 'g'): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }),
  );
}

export async function queueDepth(queueUrl: string): Promise<{ visible: number; inFlight: number; delayed: number }> {
  const res = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed'],
    }),
  );
  return {
    visible: Number(res.Attributes?.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(res.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
    delayed: Number(res.Attributes?.ApproximateNumberOfMessagesDelayed ?? 0),
  };
}

/** Drena a fila (consome e apaga) devolvendo os corpos. Usado para inspecionar eventos/DLQ. */
export async function drainQueue(queueUrl: string, options: { maxWaitMs?: number; expected?: number } = {}): Promise<Message[]> {
  const deadline = Date.now() + (options.maxWaitMs ?? 5_000);
  const out: Message[] = [];
  while (Date.now() < deadline) {
    const res = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ['All'], MessageSystemAttributeNames: ['All'] }),
    );
    const msgs = res.Messages ?? [];
    for (const m of msgs) {
      out.push(m);
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle! }));
    }
    if (options.expected !== undefined && out.length >= options.expected) break;
    if (msgs.length === 0 && options.expected === undefined) break;
  }
  return out;
}

export async function purge(queueUrl: string): Promise<void> {
  try {
    await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
  } catch {
    /* fila pode não existir ainda */
  }
}

export async function deleteQueues(urls: string[]): Promise<void> {
  await Promise.allSettled(urls.map((QueueUrl) => sqs.send(new DeleteQueueCommand({ QueueUrl }))));
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, options: { timeoutMs?: number; intervalMs?: number; label?: string } = {}): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${options.label ?? 'condition'}`);
    await Bun.sleep(options.intervalMs ?? 100);
  }
}
