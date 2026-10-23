import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money } from '../../src/domain/money/money';

describe('Money', () => {
  it('normaliza para escala 2', () => {
    expect(Money.from({ amount: '25', currency: 'BRL' }).amount).toBe('25.00');
    expect(Money.from({ amount: '25.5', currency: 'BRL' }).amount).toBe('25.50');
    expect(Money.from({ amount: '0', currency: 'BRL' }).toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  it('não arredonda: mais de 2 casas é rejeitado, não truncado', () => {
    expect(() => Money.from({ amount: '10.555', currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '10.001', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  it.each(['', ' ', 'NaN', 'Infinity', '-Infinity', '1e5', '1E2', '1,50', '1.', '.5', ' 1.00', '1.00 ', '+1.00', 'abc', '0x10', '1_000'])(
    'rejeita entrada inválida %p',
    (amount) => {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
    },
  );

  it('rejeita amount que não é string (number nunca entra)', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: null as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  it('rejeita moeda fora do ISO-4217', () => {
    expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '1.00', currency: 'BRLL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '1.00', currency: '' })).toThrow(InvalidMoneyError);
  });

  it('soma e subtrai sem erro de ponto flutuante', () => {
    const a = Money.from({ amount: '0.10', currency: 'BRL' });
    const b = Money.from({ amount: '0.20', currency: 'BRL' });
    expect(a.add(b).amount).toBe('0.30');
    expect(Money.from({ amount: '1.00', currency: 'BRL' }).subtract(Money.from({ amount: '0.90', currency: 'BRL' })).amount).toBe('0.10');
    // 100 somas de 0.01 dão exatamente 1.00
    let acc = Money.zero('BRL');
    const cent = Money.from({ amount: '0.01', currency: 'BRL' });
    for (let i = 0; i < 100; i++) acc = acc.add(cent);
    expect(acc.amount).toBe('1.00');
  });

  it('é imutável: operações devolvem instâncias novas', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = a.add(Money.from({ amount: '5.00', currency: 'BRL' }));
    expect(a.amount).toBe('10.00');
    expect(b.amount).toBe('15.00');
    expect(Object.isFrozen(a)).toBe(true);
  });

  it('lida com valores grandes sem perder precisão', () => {
    const big = Money.from({ amount: '9999999999999999.99', currency: 'BRL' });
    expect(big.add(Money.from({ amount: '0.01', currency: 'BRL' })).amount).toBe('10000000000000000.00');
  });

  it('comparações', () => {
    const ten = Money.from({ amount: '10.00', currency: 'BRL' });
    const five = Money.from({ amount: '5.00', currency: 'BRL' });
    expect(five.isLessThan(ten)).toBe(true);
    expect(ten.isLessThan(five)).toBe(false);
    expect(ten.isGreaterThan(five)).toBe(true);
    expect(ten.equals(Money.from({ amount: '10', currency: 'BRL' }))).toBe(true);
    expect(ten.equals(Money.from({ amount: '10.00', currency: 'USD' }))).toBe(false);
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(ten.isPositive()).toBe(true);
    expect(ten.negate().isNegative()).toBe(true);
    expect(ten.negate().amount).toBe('-10.00');
    expect(ten.subtract(ten).isZero()).toBe(true);
  });

  it('operações entre moedas diferentes lançam erro de domínio', () => {
    const brl = Money.from({ amount: '1.00', currency: 'BRL' });
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl.hasSameCurrency(usd)).toBe(false);
  });

  it('serializa como string decimal', () => {
    const m = Money.from({ amount: '25.5', currency: 'BRL' });
    expect(JSON.stringify(m)).toBe('{"amount":"25.50","currency":"BRL"}');
    expect(m.toString()).toBe('25.50 BRL');
  });
});
