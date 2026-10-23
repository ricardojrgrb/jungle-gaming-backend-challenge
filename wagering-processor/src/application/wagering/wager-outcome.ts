import { type MoneyProps } from '../../domain/money/money';
import { FailureCode } from '../../domain/wagering/failure-code';
import { WagerTransaction, WagerTransactionStatus } from '../../domain/wagering/wager-transaction';

/** Resposta do processamento — é o que a API devolve e o que um replay repete. */
export interface WagerOutcome {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  balance: MoneyProps;
  idempotentReplay: boolean;
}

export function outcomeFrom(tx: WagerTransaction, idempotentReplay: boolean): WagerOutcome {
  if (!tx.balanceAfter) {
    // Toda transação que saiu de PENDING carrega o saldo observado.
    throw new Error(`transaction ${tx.id} has no observed balance (status ${tx.status})`);
  }
  return {
    transactionId: tx.id,
    status: tx.status,
    ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
    balance: tx.balanceAfter.toJSON(),
    idempotentReplay,
  };
}
