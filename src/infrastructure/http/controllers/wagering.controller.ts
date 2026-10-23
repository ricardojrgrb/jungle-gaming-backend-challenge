import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ValidationError } from '../../../application/shared/errors';
import { GetWagerTransactionUseCase } from '../../../application/wagering/get-wager-transaction.use-case';
import { ProcessWagerTransactionUseCase } from '../../../application/wagering/process-wager-transaction.use-case';
import { type WagerOutcome } from '../../../application/wagering/wager-outcome';
import { WagerTransactionStatus } from '../../../domain/wagering/wager-transaction';
import { requestContext } from '../../observability/request-context';
import { type AuthenticatedRequest, ProviderAuthGuard, assertProviderMatches } from '../auth/provider-auth.guard';
import { type SubmitWagerDto, submitWagerSchema } from '../dto/schemas';
import { presentTransaction } from '../presenters';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { currentCorrelationId } from '../correlation.middleware';

/**
 * Status da resposta de POST /wagering/transactions:
 *   200 PROCESSED            (replay também: mesmo corpo + idempotentReplay=true)
 *   202 PENDING_REFERENCE    aceita, aguardando a referência
 *   422 REJECTED             regra de negócio; corpo traz failureCode
 * Erros estruturais (400/404/409/503) saem pelo AppExceptionFilter.
 */
function statusFor(outcome: WagerOutcome): number {
  switch (outcome.status) {
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return 422;
    default:
      return 200;
  }
}

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    private readonly processor: ProcessWagerTransactionUseCase,
    private readonly queries: GetWagerTransactionUseCase,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body(new ZodValidationPipe(submitWagerSchema)) body: SubmitWagerDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.trim().length === 0 || idempotencyKey.length > 512) {
      throw new ValidationError('Idempotency-Key header is required', { code: 'IDEMPOTENCY_KEY_MISSING' });
    }
    assertProviderMatches(req, body.providerId);
    requestContext.set({ walletId: body.walletId, providerId: body.providerId });

    const correlationId = currentCorrelationId();
    const result = await this.processor.execute(
      { ...body, idempotencyKey: idempotencyKey.trim() },
      { correlationId, source: 'http' },
    );
    if (result.type !== 'outcome') {
      // Sem inbox no caminho HTTP isso não acontece; é só para o tipo fechar.
      throw new Error('unexpected duplicate_message result on HTTP path');
    }
    res.status(statusFor(result.outcome)).json(result.outcome);
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId', ParseUUIDPipe) transactionId: string) {
    return presentTransaction(await this.queries.byId(transactionId));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byProvider(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    assertProviderMatches(req, providerId);
    return presentTransaction(await this.queries.byProvider(providerId, externalTransactionId));
  }
}
