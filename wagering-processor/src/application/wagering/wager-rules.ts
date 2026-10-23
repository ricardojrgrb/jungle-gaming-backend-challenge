import { FailureCode } from '../../domain/wagering/failure-code';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction';

/**
 * Quais kinds cada operação pode referenciar. WIN/LOSS podem (opcionalmente)
 * apontar para a BET da rodada; REFUND só reverte BET; ROLLBACK reverte BET, WIN
 * ou REFUND. ROLLBACK de ROLLBACK e de LOSS ficam fora: não há saldo para desfazer.
 */
const ALLOWED_REFERENCE_KINDS: Record<WagerTransactionKind, readonly WagerTransactionKind[]> = {
  [WagerTransactionKind.Opening]: [],
  [WagerTransactionKind.Bet]: [],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

/**
 * Valida uma referência já encontrada. Devolve o failureCode da primeira regra
 * violada, ou null se está tudo certo. A regra "já revertida" fica fora daqui
 * porque precisa de uma consulta (ver use case).
 */
export function validateReference(tx: WagerTransaction, reference: WagerTransaction): FailureCode | null {
  if (!ALLOWED_REFERENCE_KINDS[tx.kind].includes(reference.kind)) {
    return FailureCode.ReferenceKindNotAllowed;
  }
  if (
    reference.playerId !== tx.playerId ||
    reference.walletId !== tx.walletId ||
    reference.roundId !== tx.roundId ||
    reference.money.currency !== tx.money.currency
  ) {
    return FailureCode.ReferenceMismatch;
  }
  if (reference.status !== WagerTransactionStatus.Processed) {
    return FailureCode.ReferenceNotProcessed;
  }
  if (tx.isReversal() && !reference.money.equals(tx.money)) {
    return FailureCode.ReferenceAmountMismatch;
  }
  return null;
}

/** A referência ainda pode aparecer/resolver? Então vale esperar em vez de rejeitar. */
export function referenceStillPending(reference: WagerTransaction | null): boolean {
  return (
    reference === null ||
    reference.status === WagerTransactionStatus.Pending ||
    reference.status === WagerTransactionStatus.PendingReference
  );
}
