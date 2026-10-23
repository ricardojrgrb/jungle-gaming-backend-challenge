import { z } from 'zod';
import { Money } from '../../../domain/money/money';
import { SUBMITTABLE_KINDS, WagerTransactionKind } from '../../../domain/wagering/wager-transaction';

// Validação estrutural na borda. Regras de negócio ficam no domínio; aqui só
// garantimos que o que chega tem o formato do contrato.

export const moneySchema = z.object({
  // Sem sinal, até 2 casas, sem notação científica. "25.5" passa e vira "25.50".
  amount: z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, 'amount must be a decimal string with at most 2 decimal places'),
  currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be an ISO-4217 code'),
});

export const positiveMoneySchema = moneySchema.refine((m) => Money.from(m).isPositive(), {
  message: 'amount must be greater than zero',
  path: ['amount'],
});

export const openWalletSchema = z.object({
  playerId: z.string().uuid(),
  initialBalance: moneySchema, // zero é permitido
});

export const submitWagerSchema = z
  .object({
    providerId: z.string().min(1).max(128),
    externalTransactionId: z.string().min(1).max(256),
    playerId: z.string().uuid(),
    walletId: z.string().uuid(),
    roundId: z.string().min(1).max(256),
    gameId: z.string().min(1).max(256),
    // OPENING não está aqui de propósito: é interno.
    kind: z.enum(SUBMITTABLE_KINDS),
    money: positiveMoneySchema,
    referenceExternalTransactionId: z.string().min(1).max(256).optional(),
  })
  .superRefine((value, ctx) => {
    const needsReference = value.kind === WagerTransactionKind.Refund || value.kind === WagerTransactionKind.Rollback;
    if (needsReference && !value.referenceExternalTransactionId) {
      ctx.addIssue({
        code: 'custom',
        path: ['referenceExternalTransactionId'],
        message: `${value.kind} requires referenceExternalTransactionId`,
      });
    }
    if (value.referenceExternalTransactionId === value.externalTransactionId) {
      ctx.addIssue({
        code: 'custom',
        path: ['referenceExternalTransactionId'],
        message: 'a transaction cannot reference itself',
      });
    }
  });

export const ledgerQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type OpenWalletDto = z.infer<typeof openWalletSchema>;
export type SubmitWagerDto = z.infer<typeof submitWagerSchema>;
export type LedgerQueryDto = z.infer<typeof ledgerQuerySchema>;
