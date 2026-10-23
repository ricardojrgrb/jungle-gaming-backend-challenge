/**
 * Backoff exponencial para transações PENDING_REFERENCE.
 *
 * Com os defaults: 5s, 10s, 20s, 40s, 80s, 160s, 300s, 300s → ~15 min de espera
 * total em 8 tentativas. Cobre reentregas do SQS (visibility 30s × 5) e uma
 * indisponibilidade curta; passou disso, é muito mais provável que a referência
 * esteja errada do que atrasada, e o provedor precisa saber (REFERENCE_NOT_FOUND).
 */
export interface ReferenceRetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_REFERENCE_RETRY_POLICY: ReferenceRetryPolicy = {
  maxAttempts: 8,
  baseDelayMs: 5_000,
  maxDelayMs: 300_000,
};

/** Delay para a tentativa `attempt` (1-based). */
export function referenceRetryDelayMs(policy: ReferenceRetryPolicy, attempt: number): number {
  const exp = Math.max(0, attempt - 1);
  return Math.min(policy.baseDelayMs * 2 ** exp, policy.maxDelayMs);
}
