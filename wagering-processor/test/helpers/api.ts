export interface SubmitInput {
  providerId?: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId?: string;
  gameId?: string;
  kind: string;
  amount: string;
  currency?: string;
  referenceExternalTransactionId?: string;
  idempotencyKey?: string;
}

export function submitBody(input: SubmitInput) {
  return {
    providerId: input.providerId ?? 'provider-a',
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId ?? 'round-1',
    gameId: input.gameId ?? 'fortune-chimp',
    kind: input.kind,
    money: { amount: input.amount, currency: input.currency ?? 'BRL' },
    ...(input.referenceExternalTransactionId ? { referenceExternalTransactionId: input.referenceExternalTransactionId } : {}),
  };
}

// Nos testes a resposta é inspecionada livremente; `any` aqui é deliberado.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export class ApiClient {
  constructor(public readonly baseUrl: string) {}

  async createWallet(playerId: string, amount = '100.00', currency = 'BRL') {
    const res = await fetch(`${this.baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount, currency } }),
    });
    const body: Json = await res.json();
    return { status: res.status, body };
  }

  async submit(input: SubmitInput, headers: Record<string, string> = {}) {
    const providerId = input.providerId ?? 'provider-a';
    const res = await fetch(`${this.baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': input.idempotencyKey ?? `${providerId}:${input.externalTransactionId}`,
        ...headers,
      },
      body: JSON.stringify(submitBody(input)),
    });
    const body: Json = await res.json();
    return { status: res.status, body };
  }

  async get(path: string) {
    const res = await fetch(`${this.baseUrl}${path}`);
    const body: Json = await res.json();
    return { status: res.status, body };
  }

  async post(path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed: Json = await res.json();
    return { status: res.status, body: parsed };
  }
}

export function uuid(): string {
  return crypto.randomUUID();
}
