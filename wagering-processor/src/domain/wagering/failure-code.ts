/**
 * Taxonomia de falhas. Cada código diz ao provedor o que fazer:
 *   - "corrija o payload" (mismatch, kind não permitido, valor diferente);
 *   - "não reenvie, é definitivo" (saldo insuficiente, referência já revertida);
 *   - "reenvie com a referência certa" (referência inexistente).
 *
 * Os códigos são persistidos na transação e vão no evento WagerTransactionRejected,
 * então mudar um deles é mudança de contrato.
 */
export const FailureCode = {
  // BET sem saldo. Definitivo para esta transação; o provedor não deve reenviar.
  InsufficientFunds: 'INSUFFICIENT_FUNDS',
  // ROLLBACK de WIN/REFUND que deixaria a wallet negativa. Diferente do acima:
  // aqui o jogador já gastou o dinheiro que o provedor quer estornar — é um caso
  // para o time de operações, não para o jogo.
  ReversalInsufficientFunds: 'REVERSAL_INSUFFICIENT_FUNDS',
  CurrencyMismatch: 'CURRENCY_MISMATCH',
  PlayerWalletMismatch: 'PLAYER_WALLET_MISMATCH',
  // Esgotou o tempo de espera por uma referência que nunca chegou.
  ReferenceNotFound: 'REFERENCE_NOT_FOUND',
  // REFUND apontando para algo que não é BET, ROLLBACK apontando para LOSS/ROLLBACK...
  ReferenceKindNotAllowed: 'REFERENCE_KIND_NOT_ALLOWED',
  // Referência existe, mas de outro player/wallet/rodada/moeda.
  ReferenceMismatch: 'REFERENCE_MISMATCH',
  // Referência existe, mas foi REJECTED/FAILED — não há o que reverter.
  ReferenceNotProcessed: 'REFERENCE_NOT_PROCESSED',
  ReferenceAlreadyReversed: 'REFERENCE_ALREADY_REVERSED',
  ReferenceAmountMismatch: 'REFERENCE_AMOUNT_MISMATCH',
  // Status FAILED: erro permanente de infraestrutura ao reprocessar (auditável).
  InfrastructureFailure: 'INFRASTRUCTURE_FAILURE',
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

export const FAILURE_CODES: readonly FailureCode[] = Object.values(FailureCode);

export function isFailureCode(value: unknown): value is FailureCode {
  return typeof value === 'string' && (FAILURE_CODES as readonly string[]).includes(value);
}
