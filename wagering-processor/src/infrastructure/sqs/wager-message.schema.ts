import { z } from 'zod';
import { submitWagerSchema } from '../http/dto/schemas';

/** Envelope da fila wager-transactions.fifo. */
export const wagerMessageSchema = z.object({
  messageId: z.string().min(1).max(256),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.string().datetime({ offset: true }),
  data: submitWagerSchema.extend({
    idempotencyKey: z.string().min(1).max(512),
  }),
});

export type WagerMessage = z.infer<typeof wagerMessageSchema>;
