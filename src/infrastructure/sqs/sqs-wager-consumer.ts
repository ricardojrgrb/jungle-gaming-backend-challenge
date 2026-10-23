import { type BeforeApplicationShutdown, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { AppLogger } from '../../application/ports/logger';
import { Metrics } from '../../application/ports/metrics';
import { ApplicationError, type ErrorCategory } from '../../application/shared/errors';
import { hashWagerPayload } from '../../application/wagering/payload-hash';
import { ProcessWagerTransactionUseCase } from '../../application/wagering/process-wager-transaction.use-case';
import { DomainError } from '../../domain/shared/domain-error';
import { ConfigPort } from '../config/config';
import { FaultInjector } from '../observability/fault-injection';
import { requestContext } from '../observability/request-context';
import { type WagerMessage, wagerMessageSchema } from './wager-message.schema';

const MAX_VISIBILITY_BACKOFF_SECONDS = 300;

/**
 * Consumidor da wager-transactions.fifo.
 *
 * - Chama o MESMO use case da API; a única diferença é o bloco `inbox` no contexto,
 *   que faz a dedup por (consumerName, messageId) entrar na transação SQL.
 * - Ack (DeleteMessage) só depois do commit. Se o processo morrer entre os dois, a
 *   mensagem volta, a inbox barra o efeito duplicado e aí sim damos o ack.
 * - Erros: negócio → já virou REJECTED no banco, ack; transitório → devolve com
 *   backoff (ChangeMessageVisibility), até SQS_MAX_RECEIVE_COUNT; permanente → DLQ.
 * - Ordem: mensagens do mesmo MessageGroupId (walletId) são processadas em série;
 *   grupos diferentes, em paralelo. É otimização — a correção vem do lock no banco.
 */
@Injectable()
export class SqsWagerConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private running = false;
  private abort = new AbortController();
  private loopPromise: Promise<void> | null = null;
  private readonly inFlight = new Map<string, Message>();

  constructor(
    private readonly sqs: SQSClient,
    private readonly config: ConfigPort,
    private readonly useCase: ProcessWagerTransactionUseCase,
    private readonly metrics: Metrics,
    private readonly faults: FaultInjector,
    private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.values.ENABLE_SQS_CONSUMER) {
      this.start();
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.loopPromise = this.loop();
    this.logger.info({ queue: this.config.values.SQS_WAGER_QUEUE_URL }, 'sqs consumer started');
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    await this.stop(signal);
  }

  /**
   * SIGTERM: para de receber, espera as mensagens em andamento terminarem (até o
   * grace period) e devolve a visibilidade do que sobrou para outra instância pegar.
   */
  async stop(signal?: string): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort.abort();
    this.logger.info({ signal, inFlight: this.inFlight.size }, 'sqs consumer stopping');

    const grace = this.config.values.SHUTDOWN_GRACE_MS;
    await Promise.race([this.loopPromise ?? Promise.resolve(), Bun.sleep(grace)]);

    if (this.inFlight.size > 0) {
      this.logger.warn({ count: this.inFlight.size }, 'returning in-flight messages to the queue');
      await Promise.allSettled(
        [...this.inFlight.values()].map((m) =>
          this.sqs.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: this.config.values.SQS_WAGER_QUEUE_URL,
              ReceiptHandle: m.ReceiptHandle!,
              VisibilityTimeout: 0,
            }),
          ),
        ),
      );
    }
    this.logger.info({}, 'sqs consumer stopped');
  }

  private async loop(): Promise<void> {
    let idleBackoffMs = 0;
    while (this.running) {
      try {
        const response = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.config.values.SQS_WAGER_QUEUE_URL,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.config.values.SQS_WAIT_TIME_SECONDS,
            VisibilityTimeout: this.config.values.SQS_VISIBILITY_TIMEOUT_SECONDS,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
            MessageAttributeNames: ['All'],
          }),
          { abortSignal: this.abort.signal },
        );
        idleBackoffMs = 0;
        const messages = response.Messages ?? [];
        if (messages.length > 0) {
          await this.handleBatch(messages);
        }
      } catch (error) {
        if (!this.running || this.abort.signal.aborted) break;
        // SQS fora do ar: espera um pouco e tenta de novo, sem derrubar o processo.
        idleBackoffMs = Math.min(idleBackoffMs ? idleBackoffMs * 2 : 500, 15_000);
        this.logger.error({ error: (error as Error).message, backoffMs: idleBackoffMs }, 'sqs receive failed');
        await Bun.sleep(idleBackoffMs);
      }
    }
  }

  private async handleBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      const group = m.Attributes?.MessageGroupId ?? m.MessageId ?? 'ungrouped';
      groups.set(group, [...(groups.get(group) ?? []), m]);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (const message of group) {
          await this.handle(message);
        }
      }),
    );
  }

  /** Visível para testes: processa uma mensagem já recebida. */
  async handle(message: Message): Promise<void> {
    const key = message.MessageId ?? message.ReceiptHandle ?? '';
    this.inFlight.set(key, message);
    try {
      await this.handleInner(message);
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async handleInner(message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    let envelope: WagerMessage;
    try {
      envelope = wagerMessageSchema.parse(JSON.parse(message.Body ?? ''));
    } catch (error) {
      // Mensagem que nunca vai parsear: não adianta tentar de novo.
      await this.deadLetter(message, 'INVALID_MESSAGE', (error as Error).message);
      return;
    }

    const correlationId = message.MessageAttributes?.correlationId?.StringValue ?? envelope.messageId;
    const fields = {
      correlationId,
      messageId: envelope.messageId,
      walletId: envelope.data.walletId,
      providerId: envelope.data.providerId,
      source: 'sqs',
    };

    await requestContext.run(fields, async () => {
      try {
        const { idempotencyKey, ...payload } = envelope.data;
        const result = await this.useCase.execute(
          { ...payload, idempotencyKey },
          {
            correlationId,
            causationId: envelope.messageId,
            source: 'sqs',
            inbox: {
              consumerName: this.config.values.SQS_CONSUMER_NAME,
              messageId: envelope.messageId,
              payloadHash: hashWagerPayload(payload),
            },
          },
        );

        // Commit já aconteceu. Um crash aqui é exatamente o cenário "morto depois
        // do commit e antes do ack": a redelivery bate na inbox e só dá ack.
        this.faults.crashIfArmed('sqs:after-commit-before-ack');

        await this.ack(message);
        this.metrics.sqsBusinessAck();
        if (result.type === 'outcome') {
          this.logger.info({ transactionId: result.outcome.transactionId, status: result.outcome.status }, 'message processed');
        }
      } catch (error) {
        await this.handleFailure(message, envelope, error, receiveCount);
      }
    });
  }

  private async handleFailure(message: Message, envelope: WagerMessage, error: unknown, receiveCount: number): Promise<void> {
    const category = categorize(error);
    const err = error as Error & { code?: string };

    if (category === 'transient') {
      const max = this.config.values.SQS_MAX_RECEIVE_COUNT;
      if (receiveCount >= max) {
        this.logger.error({ receiveCount, error: err.message }, 'transient failures exhausted, dead-lettering');
        await this.deadLetter(message, 'RETRIES_EXHAUSTED', err.message);
        return;
      }
      const backoff = Math.min(2 ** receiveCount, MAX_VISIBILITY_BACKOFF_SECONDS);
      this.metrics.sqsRetry();
      this.logger.warn({ receiveCount, backoffSeconds: backoff, error: err.message }, 'transient failure, returning message with backoff');
      try {
        await this.sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.config.values.SQS_WAGER_QUEUE_URL,
            ReceiptHandle: message.ReceiptHandle!,
            VisibilityTimeout: backoff,
          }),
        );
      } catch (visibilityError) {
        // Se nem isso dá, a visibilidade expira sozinha. Só registra.
        this.logger.warn({ error: (visibilityError as Error).message }, 'could not change message visibility');
      }
      return;
    }

    // validation / not_found / conflict / permanent: repetir não muda o resultado.
    this.logger.error({ category, code: err.code, error: err.message, messageId: envelope.messageId }, 'permanent failure, dead-lettering');
    await this.deadLetter(message, err.code ?? category.toUpperCase(), err.message);
  }

  private async ack(message: Message): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({ QueueUrl: this.config.values.SQS_WAGER_QUEUE_URL, ReceiptHandle: message.ReceiptHandle! }),
    );
  }

  private async deadLetter(message: Message, reason: string, detail: string): Promise<void> {
    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: this.config.values.SQS_WAGER_DLQ_URL,
          MessageBody: message.Body ?? '',
          MessageGroupId: message.Attributes?.MessageGroupId ?? 'dlq',
          MessageDeduplicationId: `${message.MessageId}-${message.Attributes?.ApproximateReceiveCount ?? '1'}`,
          MessageAttributes: {
            ...(message.MessageAttributes ?? {}),
            failureReason: { DataType: 'String', StringValue: reason.slice(0, 256) },
            failureDetail: { DataType: 'String', StringValue: detail.slice(0, 1024) || '-' },
            originalMessageId: { DataType: 'String', StringValue: message.MessageId ?? '-' },
          },
        }),
      );
      await this.ack(message);
      this.metrics.sqsDeadLettered(reason);
    } catch (error) {
      // Não conseguiu mover: deixa a visibilidade expirar e o redrive do SQS decide.
      this.logger.error({ error: (error as Error).message, reason }, 'failed to move message to DLQ');
    }
  }
}

function categorize(error: unknown): ErrorCategory {
  if (error instanceof ApplicationError) return error.category;
  if (error instanceof DomainError) return 'permanent';
  // Desconhecido: assume transitório. O limite de recebimentos impede loop infinito.
  return 'transient';
}
