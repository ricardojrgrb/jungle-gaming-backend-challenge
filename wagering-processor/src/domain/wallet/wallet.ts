import { Money } from '../money/money';
import { CurrencyMismatchError } from '../money/money';
import { DomainError, InvariantViolationError } from '../shared/domain-error';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class InsufficientFundsError extends DomainError {
  // Sem valores na mensagem: ela pode acabar em log, e log não carrega dinheiro.
  constructor(walletId: string) {
    super('INSUFFICIENT_FUNDS', `wallet ${walletId} has insufficient funds for this debit`, { walletId });
  }
}

/**
 * Aggregate root. Toda mudança de saldo passa por `debit`/`credit`, que devolvem o
 * lançamento correspondente — o use case persiste wallet + lançamento juntos, então
 * não existe caminho para mudar saldo sem ledger.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet já com o saldo inicial e version 1. O lançamento OPENING é montado
   * pelo use case (precisa do id da transação interna) — a versão não incrementa porque
   * a abertura não é "uma mudança de saldo", é o estado inicial.
   */
  static open(props: { id: string; playerId: string; initialBalance: Money; now: Date }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvariantViolationError('initial balance cannot be negative');
    }
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.now,
      props.now,
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  acceptsCurrency(currency: string): boolean {
    return this.currency === currency;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(transactionId: string, money: Money, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    if (!this.canDebit(money)) {
      throw new InsufficientFundsError(this.id);
    }
    return this.apply(LedgerDirection.Debit, transactionId, money, at);
  }

  credit(transactionId: string, money: Money, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    return this.apply(LedgerDirection.Credit, transactionId, money, at);
  }

  private apply(
    direction: LedgerDirection,
    transactionId: string,
    money: Money,
    at: Date,
  ): WalletLedgerEntry {
    if (!money.isPositive()) {
      throw new InvariantViolationError('cannot apply a non-positive amount', {
        amount: money.toString(),
      });
    }
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(money) : before.subtract(money);
    if (after.isNegative()) {
      // canDebit já cobre isso para débito; aqui é só a última linha de defesa.
      throw new InsufficientFundsError(this.id);
    }

    this._balance = after;
    this._version += 1;
    this._updatedAt = at;

    return WalletLedgerEntry.create({
      walletId: this.id,
      transactionId,
      walletVersion: this._version,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: at,
    });
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
