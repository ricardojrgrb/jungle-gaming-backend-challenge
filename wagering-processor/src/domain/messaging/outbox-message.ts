import { InvariantViolationError } from '../shared/domain-error';
import { IntegrationEvent } from './integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | undefined;
  publishedAt?: Date | undefined;
}

/**
 * Backoff do publisher: 1s, 2s, 4s ... até 5 min, e nunca desiste. Evento
 * financeiro não vai para o lixo por falha de broker; o que sinaliza problema
 * é a métrica de lag e de tentativas.
 */
export const OUTBOX_RETRY_BASE_MS = 1_000;
export const OUTBOX_RETRY_MAX_MS = 300_000;

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date | undefined,
    private _publishedAt?: Date | undefined,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = event.toJSON() as unknown as Record<string, unknown>;
    // id da outbox == eventId: um evento, uma linha, e o consumidor deduplica pelo mesmo id.
    return new OutboxMessage(event.eventId, event.aggregateId, event.eventType, Object.freeze(payload), event.occurredAt, 0);
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      Object.freeze({ ...state.payload }),
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvariantViolationError(`outbox message ${this.id} already published`);
    }
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** incrementa attempts e calcula o próximo nextAttemptAt (backoff) */
  scheduleRetry(now: Date): void {
    if (!this.isPending()) {
      throw new InvariantViolationError(`outbox message ${this.id} already published`);
    }
    this._attempts += 1;
    const delay = Math.min(OUTBOX_RETRY_BASE_MS * 2 ** (this._attempts - 1), OUTBOX_RETRY_MAX_MS);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
