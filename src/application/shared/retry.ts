import { TransientInfrastructureError } from './errors';

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  /** Decide se vale repetir; por padrão só erros transitórios. */
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number) => void;
}

/**
 * Retry curto com backoff + jitter para conflitos de lock/versão. É deliberadamente
 * pequeno: se o banco está fora, quem decide o backoff longo é a borda (SQS/HTTP),
 * não um loop aqui dentro.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const shouldRetry = options.shouldRetry ?? ((e) => e instanceof TransientInfrastructureError);
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === options.attempts || !shouldRetry(error)) {
        throw error;
      }
      options.onRetry?.(error, attempt);
      const delay = options.baseDelayMs * 2 ** (attempt - 1) + Math.random() * options.baseDelayMs;
      await Bun.sleep(delay);
    }
  }
  throw lastError;
}
