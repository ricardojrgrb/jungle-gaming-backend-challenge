import { describe, expect, it } from 'bun:test';
import { canonicalJson, hashWagerPayload } from '../../src/application/wagering/payload-hash';

const base = {
  providerId: 'provider-a',
  externalTransactionId: 't-1',
  playerId: 'p',
  walletId: 'w',
  roundId: 'r',
  gameId: 'g',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('payload hash', () => {
  it('JSON canônico ordena chaves recursivamente e omite undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [{ z: 1, y: 2 }] } })).toBe('{"a":{"c":[{"y":2,"z":1}]},"b":1}');
  });

  it('é determinístico e independe da ordem das chaves', () => {
    const shuffled = { money: { currency: 'BRL', amount: '25.00' }, kind: 'BET', gameId: 'g', roundId: 'r', walletId: 'w', playerId: 'p', externalTransactionId: 't-1', providerId: 'provider-a' };
    expect(hashWagerPayload(base)).toBe(hashWagerPayload(shuffled));
    expect(hashWagerPayload(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normaliza o amount antes de hashear ("25.0" == "25.00")', () => {
    expect(hashWagerPayload({ ...base, money: { amount: '25.0', currency: 'BRL' } })).toBe(hashWagerPayload(base));
    expect(hashWagerPayload({ ...base, money: { amount: '25', currency: 'BRL' } })).toBe(hashWagerPayload(base));
  });

  it('qualquer campo de negócio diferente muda o hash', () => {
    const h = hashWagerPayload(base);
    expect(hashWagerPayload({ ...base, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(h);
    expect(hashWagerPayload({ ...base, kind: 'WIN' })).not.toBe(h);
    expect(hashWagerPayload({ ...base, roundId: 'r2' })).not.toBe(h);
    expect(hashWagerPayload({ ...base, referenceExternalTransactionId: 'x' })).not.toBe(h);
  });

  it('referência ausente e undefined são equivalentes', () => {
    expect(hashWagerPayload({ ...base, referenceExternalTransactionId: undefined })).toBe(hashWagerPayload(base));
  });
});
