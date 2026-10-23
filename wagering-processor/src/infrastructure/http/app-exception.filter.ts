import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { AppLogger } from '../../application/ports/logger';
import { ApplicationError } from '../../application/shared/errors';
import { InvalidMoneyError } from '../../domain/money/money';
import { DomainError, InvariantViolationError } from '../../domain/shared/domain-error';
import { ReferenceRequiredError } from '../../domain/wagering/wager-transaction';
import { requestContext } from '../observability/request-context';

/**
 * Mapeamento único de erro → status HTTP, usado por todos os endpoints:
 *
 *   400 payload inválido              VALIDATION_ERROR, INVALID_MONEY, IDEMPOTENCY_KEY_MISSING
 *   401/403 autenticação              UNAUTHORIZED, PROVIDER_MISMATCH
 *   404 recurso inexistente           WALLET_NOT_FOUND, TRANSACTION_NOT_FOUND
 *   409 conflito                      WALLET_ALREADY_EXISTS, IDEMPOTENCY_CONFLICT
 *   422 rejeição por regra de negócio (não passa por aqui: é resposta normal com status REJECTED)
 *   503 falha transitória             SERVICE_UNAVAILABLE (+ Retry-After)
 *   500 erro permanente/inesperado    INTERNAL_ERROR
 */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const correlationId = requestContext.get()?.correlationId;
    const { status, code, message, details } = this.translate(exception);

    if (status >= 500) {
      this.logger.error(
        { status, code, error: exception instanceof Error ? exception.message : String(exception), stack: exception instanceof Error ? exception.stack : undefined },
        'request failed',
      );
    } else {
      this.logger.debug({ status, code }, 'request rejected');
    }

    if (status === HttpStatus.SERVICE_UNAVAILABLE) {
      response.setHeader('Retry-After', '1');
    }
    response.status(status).json({ error: { code, message, ...(details ? { details } : {}) }, correlationId });
  }

  private translate(exception: unknown): { status: number; code: string; message: string; details?: Record<string, unknown> } {
    if (exception instanceof ApplicationError) {
      const status = {
        validation: HttpStatus.BAD_REQUEST,
        not_found: HttpStatus.NOT_FOUND,
        conflict: HttpStatus.CONFLICT,
        transient: HttpStatus.SERVICE_UNAVAILABLE,
        permanent: HttpStatus.INTERNAL_SERVER_ERROR,
      }[exception.category];
      return { status, code: exception.code, message: exception.message, ...(exception.details ? { details: exception.details } : {}) };
    }
    if (exception instanceof InvalidMoneyError || exception instanceof ReferenceRequiredError) {
      return { status: HttpStatus.BAD_REQUEST, code: exception.code, message: exception.message, ...(exception.details ? { details: exception.details } : {}) };
    }
    if (exception instanceof InvariantViolationError) {
      return { status: HttpStatus.INTERNAL_SERVER_ERROR, code: exception.code, message: exception.message };
    }
    if (exception instanceof DomainError) {
      return { status: HttpStatus.BAD_REQUEST, code: exception.code, message: exception.message };
    }
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const message = typeof body === 'string' ? body : ((body as { message?: string | string[] }).message ?? exception.message);
      const code = typeof body === 'object' && body && 'code' in body ? String((body as { code: unknown }).code) : httpCode(exception.getStatus());
      return { status: exception.getStatus(), code, message: Array.isArray(message) ? message.join('; ') : String(message) };
    }
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, code: 'INTERNAL_ERROR', message: 'unexpected error' };
  }
}

function httpCode(status: number): string {
  switch (status) {
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 400:
      return 'VALIDATION_ERROR';
    default:
      return 'HTTP_ERROR';
  }
}
