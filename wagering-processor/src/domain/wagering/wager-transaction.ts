import { Money } from '../money/money';
import { DomainError, InvariantViolationError } from '../shared/domain-error';
import { newId } from '../shared/ids';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';
import { FailureCode } from './failure-code';
import { type ReferenceRetryPolicy, referenceRetryDelayMs } from './reference-retry-policy';

export enum WagerTransactionKind {
  Opening = 'OPENING', // interno: crédito de abertura da wallet
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

/** Kinds que um provedor pode submeter (API ou fila). OPENING fica de fora. */
export const SUBMITTABLE_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

export enum WagerTransactionStatus {
  Pending = 'PENDING', // aceita, ainda não aplicada
  PendingReference = 'PENDING_REFERENCE', // aguardando a transação referenciada
  Processed = 'PROCESSED', // aplicada (terminal)
  Rejected = 'REJECTED', // violação de regra de negócio (terminal)
  Failed = 'FAILED', // erro permanente de infraestrutura (terminal, auditável)
}

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/**
 * Transições válidas:
 *
 *   PENDING ───────────────► PROCESSED
 *   PENDING ───────────────► REJECTED
 *   PENDING ───────────────► FAILED
 *   PENDING ───────────────► PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
 *   PENDING_REFERENCE ─────► PENDING_REFERENCE (nova tentativa agendada)
 *
 * Qualquer transição a partir de um estado terminal é erro de programação.
 */
export class InvalidTransactionStateError extends InvariantViolationError {
  constructor(transactionId: string, from: WagerTransactionStatus, to: WagerTransactionStatus) {
    super(`transaction ${transactionId} cannot move from ${from} to ${to}`, {
      transactionId,
      from,
      to,
    });
  }
}

export class ReferenceRequiredError extends DomainError {
  constructor(kind: WagerTransactionKind) {
    super('REFERENCE_REQUIRED', `${kind} requires referenceExternalTransactionId`, { kind });
  }
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  processedAt?: Date | undefined;
  /** Saldo da wallet observado quando a transação chegou ao resultado atual. */
  balanceAfter?: Money | undefined;
  referenceAttempts: number;
  nextReferenceRetryAt?: Date | undefined;
}

export interface CreateWagerTransactionProps {
  id?: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _balanceAfter: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceRetryAt: Date | undefined,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvariantViolationError('OPENING is internal; use WagerTransaction.opening()');
    }
    if (!props.money.isPositive()) {
      throw new InvariantViolationError('transaction amount must be positive', {
        amount: props.money.toString(),
      });
    }
    const tx = WagerTransaction.build(props);
    if (tx.requiresReference() && !tx.referenceExternalTransactionId) {
      throw new ReferenceRequiredError(tx.kind);
    }
    return tx;
  }

  /** Crédito de abertura da wallet. Só o OpenWallet use case chama isso. */
  static opening(props: {
    walletId: string;
    playerId: string;
    money: Money;
    createdAt: Date;
  }): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvariantViolationError('opening amount must be positive');
    }
    const id = newId();
    const tx = WagerTransaction.build({
      id,
      providerId: 'internal',
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: `internal:opening:${props.walletId}`,
      payloadHash: '0'.repeat(64),
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: `opening:${props.walletId}`,
      gameId: 'internal',
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.createdAt,
    });
    tx.markProcessed(undefined, props.createdAt, props.money);
    return tx;
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.balanceAfter,
      state.referenceAttempts,
      state.nextReferenceRetryAt,
    );
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    return new WagerTransaction(
      props.id ?? newId(),
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceRetryAt(): Date | undefined {
    return this._nextReferenceRetryAt;
  }

  // ---- transições

  markProcessed(referenceTransactionId: string | undefined, at: Date, balanceAfter: Money): void {
    this.transitionTo(WagerTransactionStatus.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._balanceAfter = balanceAfter;
    this._nextReferenceRetryAt = undefined;
  }

  /** Agenda a próxima tentativa de resolver a referência (backoff exponencial). */
  markPendingReference(now: Date, policy: ReferenceRetryPolicy, balanceObserved: Money): void {
    this.transitionTo(WagerTransactionStatus.PendingReference);
    this._referenceAttempts += 1;
    this._nextReferenceRetryAt = new Date(
      now.getTime() + referenceRetryDelayMs(policy, this._referenceAttempts),
    );
    this._balanceAfter = balanceObserved;
  }

  reject(code: FailureCode, balanceObserved: Money): void {
    this.transitionTo(WagerTransactionStatus.Rejected);
    this._failureCode = code;
    this._processedAt = undefined;
    this._balanceAfter = balanceObserved;
    this._nextReferenceRetryAt = undefined;
  }

  fail(code: FailureCode): void {
    this.transitionTo(WagerTransactionStatus.Failed);
    this._failureCode = code;
    this._nextReferenceRetryAt = undefined;
  }

  private transitionTo(next: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.id, this._status, next);
    }
    this._status = next;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /** LOSS registra o resultado sem mover saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  hasExhaustedReferenceRetries(policy: ReferenceRetryPolicy): boolean {
    return this._referenceAttempts >= policy.maxAttempts;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento que esta transação produz. ROLLBACK inverte a direção
   * da referência; LOSS não tem direção porque não gera lançamento.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvariantViolationError('ROLLBACK direction depends on its reference');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvariantViolationError('LOSS does not produce a ledger entry');
    }
  }
}
