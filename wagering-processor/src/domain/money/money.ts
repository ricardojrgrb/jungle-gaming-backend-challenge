import { Decimal } from 'decimal.js';
import { DomainError } from '../shared/domain-error';

export interface MoneyProps {
  /** String decimal com escala fixa de 2 casas, ex.: "25.00". */
  amount: string;
  /** ISO-4217, ex.: "BRL". */
  currency: string;
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('INVALID_MONEY', message, details);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, actual: string) {
    super('CURRENCY_MISMATCH', `Currency mismatch: expected ${expected}, got ${actual}`, {
      expected,
      actual,
    });
  }
}

// Decimal próprio para não herdar configuração global de outro lugar do processo.
// 40 dígitos significativos: soma/subtração de numeric(18,2) nunca arredonda aqui.
const MoneyDecimal = Decimal.clone({ precision: 40 });

const SCALE = 2;
// Aceita "-" só porque o domínio precisa representar diferença negativa (reconciliação)
// e o resultado de negate(). Contratos de entrada rejeitam negativos no DTO.
const AMOUNT_RE = /^-?\d{1,16}(\.\d{1,2})?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Valor monetário imutável com escala fixa de 2 casas.
 *
 * Nunca passa por `number`: entra como string, vive como Decimal e sai como string.
 * Toda operação devolve uma instância nova.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    const { amount, currency } = props;

    if (typeof amount !== 'string' || typeof currency !== 'string') {
      throw new InvalidMoneyError('amount and currency must be strings');
    }
    if (!CURRENCY_RE.test(currency)) {
      throw new InvalidMoneyError(`invalid currency "${currency}"`, { currency });
    }
    // A regex já barra "", "NaN", "Infinity", "1e5", "1,5", " 1" e mais de 2 casas.
    if (!AMOUNT_RE.test(amount)) {
      throw new InvalidMoneyError(`invalid amount "${amount}"`, { amount });
    }

    return new Money(new MoneyDecimal(amount), currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.greaterThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  hasSameCurrency(other: Money): boolean {
    return this.currency === other.currency;
  }

  /** Sempre com 2 casas: "25.5" vira "25.50". */
  get amount(): string {
    return this.value.toFixed(SCALE);
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
