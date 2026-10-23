import { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface PublishResult {
  messageId: string;
  error?: Error;
}

export abstract class EventPublisher {
  /** Publica em lote; o resultado é por mensagem, nunca tudo-ou-nada. */
  abstract publish(messages: OutboxMessage[]): Promise<PublishResult[]>;
}
