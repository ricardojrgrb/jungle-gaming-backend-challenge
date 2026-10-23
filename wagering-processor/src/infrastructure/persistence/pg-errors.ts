import { ApplicationError, IdempotencyConflictError, PermanentInfrastructureError, TransientInfrastructureError, WalletAlreadyExistsError } from '../../application/shared/errors';
import { DomainError } from '../../domain/shared/domain-error';

interface PgLikeError {
  code?: string;
  constraint?: string;
  detail?: string;
  message?: string;
  errno?: string | number;
}

const TRANSIENT_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available (lock_timeout)
  '57014', // query_canceled (statement_timeout)
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
]);

const TRANSIENT_ERRNOS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'EHOSTUNREACH']);

/**
 * Traduz o que sai do driver/MikroORM para a taxonomia da aplicação. Tudo que
 * atravessa o UnitOfWork passa por aqui; use cases nunca veem erro de driver.
 */
export function translateDriverError(error: unknown): unknown {
  if (error instanceof ApplicationError || error instanceof DomainError) {
    return error;
  }
  if (!error || typeof error !== 'object') {
    return error;
  }
  const e = error as PgLikeError & { cause?: unknown };
  const code = typeof e.code === 'string' ? e.code : undefined;
  const errno = typeof e.errno === 'string' ? e.errno : undefined;

  if (code && TRANSIENT_SQLSTATES.has(code)) {
    return new TransientInfrastructureError(`database transient failure (${code})`, { sqlState: code }, error);
  }
  if (code && code.startsWith('08')) {
    return new TransientInfrastructureError(`database connection failure (${code})`, { sqlState: code }, error);
  }
  if ((code && TRANSIENT_ERRNOS.has(code)) || (errno && TRANSIENT_ERRNOS.has(errno))) {
    return new TransientInfrastructureError(`database unreachable (${code ?? errno})`, { errno: code ?? errno }, error);
  }
  if (typeof e.message === 'string' && /timeout|terminated|closed|connect/i.test(e.message) && !code) {
    // knex/pg às vezes só dão mensagem (pool timeout, socket fechado)
    return new TransientInfrastructureError(`database unreachable: ${e.message}`, {}, error);
  }

  if (code === '23505') {
    switch (e.constraint) {
      case 'wallets_player_currency_unique':
        return new WalletAlreadyExistsError(extractDetail(e.detail, 'player_id'), extractDetail(e.detail, 'currency'));
      case 'wager_transactions_idempotency_key_unique':
      case 'wager_transactions_provider_external_unique':
        return new IdempotencyConflictError({ constraint: e.constraint, reason: 'concurrent insert with the same key' });
      default:
        return new PermanentInfrastructureError(`unique violation on ${e.constraint ?? 'unknown'}`, { constraint: e.constraint }, error);
    }
  }
  if (code && code.startsWith('23')) {
    // check/fk/not-null: o schema barrou algo que o código deixou passar. Bug, não retry.
    return new PermanentInfrastructureError(`constraint violation ${e.constraint ?? code}`, { sqlState: code, constraint: e.constraint }, error);
  }
  return error;
}

function extractDetail(detail: string | undefined, column: string): string {
  // pg: 'Key (player_id, currency)=(uuid, BRL) already exists.'
  if (!detail) return 'unknown';
  const m = /\(([^)]+)\)=\(([^)]+)\)/.exec(detail);
  if (!m) return 'unknown';
  const cols = m[1]!.split(',').map((s) => s.trim());
  const vals = m[2]!.split(',').map((s) => s.trim());
  const idx = cols.indexOf(column);
  return idx >= 0 ? (vals[idx] ?? 'unknown') : 'unknown';
}
