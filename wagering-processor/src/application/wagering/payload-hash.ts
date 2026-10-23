import { Money } from '../../domain/money/money';

/**
 * Campos de negócio que entram no hash de idempotência. Header, messageId,
 * occurredAt e qualquer metadado de transporte ficam de fora.
 */
export interface WagerPayloadFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string | undefined;
}

/**
 * JSON canônico: chaves ordenadas recursivamente, sem espaços, `undefined` omitido.
 * O amount é normalizado para escala 2 antes ("25.5" e "25.00" são o mesmo valor,
 * então precisam gerar o mesmo hash).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) {
        out[key] = sortKeys(v);
      }
    }
    return out;
  }
  return value;
}

/** SHA-256 em hex (64 chars) do JSON canônico do subconjunto de negócio. */
export function hashWagerPayload(fields: WagerPayloadFields): string {
  const normalized: WagerPayloadFields = {
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: Money.from(fields.money).toJSON(),
    referenceExternalTransactionId: fields.referenceExternalTransactionId,
  };
  return sha256Hex(canonicalJson(normalized));
}

export function sha256Hex(input: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(input);
  return hasher.digest('hex');
}
