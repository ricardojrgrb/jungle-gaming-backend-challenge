import { Money } from '../money/money';
import { InvariantViolationError } from '../shared/domain-error';
import { newId } from '../shared/ids';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  walletVersion: number;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type CreateLedgerEntryProps = Omit<LedgerEntryState, 'id'> & { id?: string };

/**
 * Lançamento do ledger. Sem setters, sem métodos de transição, instância congelada:
 * a imutabilidade é estrutural aqui e também no banco (trigger bloqueia UPDATE/DELETE).
 *
 * `walletVersion` é a versão da wallet *depois* de aplicar este lançamento. Isso dá
 * uma ordem total por wallet (UNIQUE no banco), serve de cursor opaco na paginação e
 * amarra "1 mudança de saldo == 1 lançamento == 1 incremento de versão".
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly walletVersion: number,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(
      props.id ?? newId(),
      props.walletId,
      props.transactionId,
      props.walletVersion,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );

    if (!entry.money.isPositive()) {
      throw new InvariantViolationError('ledger entry amount must be positive', {
        amount: entry.money.toString(),
      });
    }
    if (entry.balanceBefore.isNegative() || entry.balanceAfter.isNegative()) {
      throw new InvariantViolationError('ledger balances cannot be negative');
    }
    if (!Number.isInteger(entry.walletVersion) || entry.walletVersion < 1) {
      throw new InvariantViolationError('ledger walletVersion must be >= 1');
    }
    if (!entry.isBalanced()) {
      throw new InvariantViolationError('ledger entry is not balanced', {
        direction: entry.direction,
        money: entry.money.toString(),
        balanceBefore: entry.balanceBefore.toString(),
        balanceAfter: entry.balanceAfter.toString(),
      });
    }
    return entry;
  }

  /** Reconstrução a partir do banco: confia no que foi persistido. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.walletVersion,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter (na mesma moeda). */
  isBalanced(): boolean {
    if (
      !this.money.hasSameCurrency(this.balanceBefore) ||
      !this.money.hasSameCurrency(this.balanceAfter)
    ) {
      return false;
    }
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
