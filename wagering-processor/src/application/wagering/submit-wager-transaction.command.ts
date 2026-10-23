import { type MoneyProps } from '../../domain/money/money';
import { SUBMITTABLE_KINDS } from '../../domain/wagering/wager-transaction';

export type SubmittableKind = (typeof SUBMITTABLE_KINDS)[number];

/** Payload de negócio, já validado estruturalmente pela borda (HTTP ou SQS). */
export interface SubmitWagerTransactionCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: SubmittableKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

export interface ProcessingContext {
  correlationId: string;
  causationId?: string | undefined;
  source: 'http' | 'sqs' | 'scheduler';
  /** Só quando a entrada é a fila: participa da mesma transação SQL. */
  inbox?: { consumerName: string; messageId: string; payloadHash: string } | undefined;
}
