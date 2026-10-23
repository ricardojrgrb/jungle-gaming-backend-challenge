import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, Money } from '../../src/domain/money/money';
import { InvariantViolationError } from '../../src/domain/shared/domain-error';
import { InsufficientFundsError, Wallet } from '../../src/domain/wallet/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-10-23T12:00:00Z');

function openWallet(initial = '100.00') {
  return Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(initial), now });
}

describe('Wallet', () => {
  it('abre com version 1 e saldo inicial', () => {
    const w = openWallet();
    expect(w.version).toBe(1);
    expect(w.balance.amount).toBe('100.00');
    expect(w.currency).toBe('BRL');
  });

  it('não abre com saldo negativo', () => {
    expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00').negate(), now })).toThrow(InvariantViolationError);
  });

  it('débito gera lançamento DEBIT consistente e incrementa a versão', () => {
    const w = openWallet();
    const entry = w.debit('tx1', brl('30.00'), now);
    expect(w.balance.amount).toBe('70.00');
    expect(w.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('70.00');
    expect(entry.walletVersion).toBe(2);
    expect(entry.transactionId).toBe('tx1');
    expect(entry.isBalanced()).toBe(true);
  });

  it('crédito gera lançamento CREDIT', () => {
    const w = openWallet('0.00');
    const entry = w.credit('tx1', brl('12.34'), now);
    expect(w.balance.amount).toBe('12.34');
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.amount).toBe('0.00');
    expect(entry.balanceAfter.amount).toBe('12.34');
  });

  it('saldo nunca fica negativo', () => {
    const w = openWallet('10.00');
    expect(w.canDebit(brl('10.00'))).toBe(true);
    expect(w.canDebit(brl('10.01'))).toBe(false);
    expect(() => w.debit('tx', brl('10.01'), now)).toThrow(InsufficientFundsError);
    // estado intacto depois da falha
    expect(w.balance.amount).toBe('10.00');
    expect(w.version).toBe(1);
  });

  it('débito até zero é permitido', () => {
    const w = openWallet('10.00');
    w.debit('tx', brl('10.00'), now);
    expect(w.balance.isZero()).toBe(true);
  });

  it('rejeita moeda diferente da wallet', () => {
    const w = openWallet();
    expect(() => w.debit('tx', Money.from({ amount: '1.00', currency: 'USD' }), now)).toThrow(CurrencyMismatchError);
    expect(() => w.credit('tx', Money.from({ amount: '1.00', currency: 'USD' }), now)).toThrow(CurrencyMismatchError);
    expect(w.acceptsCurrency('USD')).toBe(false);
  });

  it('não aplica valor zero ou negativo', () => {
    const w = openWallet();
    expect(() => w.credit('tx', brl('0.00'), now)).toThrow(InvariantViolationError);
    expect(() => w.debit('tx', brl('0.00'), now)).toThrow(InvariantViolationError);
  });

  it('versão só incrementa quando o saldo muda', () => {
    const w = openWallet();
    expect(w.version).toBe(1);
    w.credit('a', brl('1.00'), now);
    w.debit('b', brl('1.00'), now);
    expect(w.version).toBe(3);
    expect(w.balance.amount).toBe('100.00');
  });

  it('rehydrate não revalida nada, só reconstrói', () => {
    const w = Wallet.rehydrate({ id: 'w', playerId: 'p', currency: 'BRL', balance: brl('5.00'), version: 42, createdAt: now, updatedAt: now });
    expect(w.version).toBe(42);
    expect(w.balance.amount).toBe('5.00');
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    walletId: 'w',
    transactionId: 't',
    walletVersion: 2,
    direction: LedgerDirection.Debit,
    money: brl('10.00'),
    balanceBefore: brl('50.00'),
    balanceAfter: brl('40.00'),
    createdAt: now,
  };

  it('create valida a aritmética', () => {
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl('41.00') })).toThrow(InvariantViolationError);
    expect(() => WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit })).toThrow(InvariantViolationError);
  });

  it('não aceita valor não positivo, saldo negativo ou moeda trocada', () => {
    expect(() => WalletLedgerEntry.create({ ...base, money: brl('0.00'), balanceAfter: brl('50.00') })).toThrow(InvariantViolationError);
    expect(() => WalletLedgerEntry.create({ ...base, balanceBefore: brl('5.00'), balanceAfter: brl('5.00').subtract(brl('10.00')) })).toThrow(InvariantViolationError);
    expect(() => WalletLedgerEntry.create({ ...base, money: Money.from({ amount: '10.00', currency: 'USD' }) })).toThrow(InvariantViolationError);
    expect(() => WalletLedgerEntry.create({ ...base, walletVersion: 0 })).toThrow(InvariantViolationError);
  });

  it('é estruturalmente imutável', () => {
    const entry = WalletLedgerEntry.create(base);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { direction: string }).direction = 'CREDIT';
    }).toThrow();
    const proto = Object.getOwnPropertyNames(WalletLedgerEntry.prototype);
    expect(proto.filter((m) => /^(mark|set|update)/.test(m))).toEqual([]);
  });

  it('rehydrate reconstrói mesmo um lançamento desbalanceado (dado já persistido)', () => {
    const broken = WalletLedgerEntry.rehydrate({ id: 'x', ...base, balanceAfter: brl('0.00') });
    expect(broken.isBalanced()).toBe(false);
  });
});
