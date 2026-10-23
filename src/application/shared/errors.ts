import { DomainError } from '../../domain/shared/domain-error';

/**
 * Categorias que a borda (HTTP/SQS) precisa distinguir:
 *   validation → 400 / DLQ        conflict  → 409 / DLQ
 *   not_found  → 404 / DLQ        transient → 503 / retry com backoff
 *   permanent  → 500 / DLQ
 */
export type ErrorCategory = 'validation' | 'not_found' | 'conflict' | 'transient' | 'permanent';

export class ApplicationError extends DomainError {
  constructor(
    public readonly category: ErrorCategory,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(code, message, details);
  }
}

export class ValidationError extends ApplicationError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('validation', 'VALIDATION_ERROR', message, details);
  }
}

export class WalletNotFoundError extends ApplicationError {
  constructor(walletId: string) {
    super('not_found', 'WALLET_NOT_FOUND', `wallet ${walletId} not found`, { walletId });
  }
}

export class TransactionNotFoundError extends ApplicationError {
  constructor(details: Record<string, unknown>) {
    super('not_found', 'TRANSACTION_NOT_FOUND', 'transaction not found', details);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  constructor(playerId: string, currency: string) {
    super('conflict', 'WALLET_ALREADY_EXISTS', `player ${playerId} already has a ${currency} wallet`, {
      playerId,
      currency,
    });
  }
}

/** Mesma idempotency key (ou mesmo externalTransactionId) com payload diferente. */
export class IdempotencyConflictError extends ApplicationError {
  constructor(details: Record<string, unknown>) {
    super(
      'conflict',
      'IDEMPOTENCY_CONFLICT',
      'idempotency key already used with a different payload',
      details,
    );
  }
}

/** Banco/broker indisponível, lock timeout, deadlock, serialização: vale repetir. */
export class TransientInfrastructureError extends ApplicationError {
  constructor(message: string, details?: Record<string, unknown>, cause?: unknown) {
    super('transient', 'SERVICE_UNAVAILABLE', message, details);
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/** O UPDATE condicionado da wallet não bateu com a versão esperada. */
export class WalletVersionConflictError extends TransientInfrastructureError {
  constructor(walletId: string, expectedVersion: number) {
    super(`wallet ${walletId} version conflict (expected ${expectedVersion})`, {
      walletId,
      expectedVersion,
    });
  }
}

/** Erro de infraestrutura que repetir não resolve (constraint inesperada, bug). */
export class PermanentInfrastructureError extends ApplicationError {
  constructor(message: string, details?: Record<string, unknown>, cause?: unknown) {
    super('permanent', 'INTERNAL_ERROR', message, details);
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export function isTransientError(error: unknown): boolean {
  return error instanceof TransientInfrastructureError;
}
