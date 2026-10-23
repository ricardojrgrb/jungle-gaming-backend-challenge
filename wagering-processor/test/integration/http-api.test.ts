import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { BootstrappedApp } from '../../src/bootstrap';
import { ApiClient, uuid } from '../helpers/api';
import { startApp } from '../helpers/app';
import { assertWalletConsistent, closeOrm, getOrm, truncateAll } from '../helpers/db';
import { deleteQueues, drainQueue } from '../helpers/sqs';

describe('HTTP API', () => {
  let app: BootstrappedApp;
  let api: ApiClient;

  beforeAll(async () => {
    await getOrm();
    await truncateAll();
    app = await startApp({ ENABLE_SQS_CONSUMER: 'false', ENABLE_PENDING_REFERENCE_WORKER: 'false' }, 'http');
    api = new ApiClient(app.url);
  });
  afterAll(async () => {
    await app.close();
    await closeOrm();
  });

  it('health: live sempre 200; ready checa Postgres e SQS', async () => {
    expect((await api.get('/health/live')).status).toBe(200);
    const ready = await api.get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ postgres: { status: 'up' }, sqs: { status: 'up' } });
  });

  it('POST /wallets: 201 com OPENING no ledger; duplicada → 409; payload inválido → 400', async () => {
    const playerId = uuid();
    const created = await api.createWallet(playerId, '1000.00');
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
    const dup = await api.createWallet(playerId, '1.00');
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('WALLET_ALREADY_EXISTS');
    const bad = await api.post('/wallets', { playerId: 'not-a-uuid', initialBalance: { amount: '1.5.0', currency: 'BRL' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    expect(bad.body.error.details.issues.length).toBeGreaterThan(0);
    const negative = await api.post('/wallets', { playerId: uuid(), initialBalance: { amount: '-1.00', currency: 'BRL' } });
    expect(negative.status).toBe(400);
    const ledger = await api.get(`/wallets/${created.body.id}/ledger`);
    expect(ledger.body.items).toHaveLength(1);
    expect(ledger.body.items[0]).toMatchObject({ direction: 'CREDIT', walletVersion: 1, balanceBefore: { amount: '0.00' }, balanceAfter: { amount: '1000.00' } });
  });

  it('GET /wallets/:id: 404 para inexistente, 400 para id inválido', async () => {
    expect((await api.get(`/wallets/${uuid()}`)).status).toBe(404);
    expect((await api.get(`/wallets/abc`)).status).toBe(400);
  });

  it('POST /wagering/transactions: 200 processada, 202 pendente, 422 rejeitada, 409 conflito, 400 inválido, 404 wallet', async () => {
    const playerId = uuid();
    const walletId = (await api.createWallet(playerId, '100.00')).body.id;
    const bet = await api.submit({ externalTransactionId: 'bet-1', playerId, walletId, kind: 'BET', amount: '80.00' });
    expect(bet.status).toBe(200);
    expect(bet.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '20.00' }, idempotentReplay: false });

    const replay = await api.submit({ externalTransactionId: 'bet-1', playerId, walletId, kind: 'BET', amount: '80.00' });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...bet.body, idempotentReplay: true });

    const conflict = await api.submit({ externalTransactionId: 'bet-1', playerId, walletId, kind: 'BET', amount: '81.00' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');

    const rejected = await api.submit({ externalTransactionId: 'bet-2', playerId, walletId, kind: 'BET', amount: '80.00' });
    expect(rejected.status).toBe(422);
    expect(rejected.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '20.00' } });
    // replay de rejeição mantém o 422 e o corpo
    const rejectedReplay = await api.submit({ externalTransactionId: 'bet-2', playerId, walletId, kind: 'BET', amount: '80.00' });
    expect(rejectedReplay.status).toBe(422);
    expect(rejectedReplay.body.idempotentReplay).toBe(true);

    const pending = await api.submit({ externalTransactionId: 'refund-x', playerId, walletId, kind: 'REFUND', amount: '5.00', referenceExternalTransactionId: 'nope' });
    expect(pending.status).toBe(202);
    expect(pending.body.status).toBe('PENDING_REFERENCE');

    const noHeader = await api.post('/wagering/transactions', { providerId: 'p', externalTransactionId: 'x', playerId, walletId, roundId: 'r', gameId: 'g', kind: 'BET', money: { amount: '1.00', currency: 'BRL' } });
    expect(noHeader.status).toBe(400);
    expect(noHeader.body.error.details.code).toBe('IDEMPOTENCY_KEY_MISSING');

    const opening = await api.submit({ externalTransactionId: 'op', playerId, walletId, kind: 'OPENING', amount: '1.00' });
    expect(opening.status).toBe(400);
    const noRef = await api.submit({ externalTransactionId: 'nr', playerId, walletId, kind: 'ROLLBACK', amount: '1.00' });
    expect(noRef.status).toBe(400);
    const zero = await api.submit({ externalTransactionId: 'z', playerId, walletId, kind: 'BET', amount: '0.00' });
    expect(zero.status).toBe(400);
    const sci = await api.submit({ externalTransactionId: 's', playerId, walletId, kind: 'BET', amount: '1e2' });
    expect(sci.status).toBe(400);
    const missingWallet = await api.submit({ externalTransactionId: 'mw', playerId, walletId: uuid(), kind: 'BET', amount: '1.00' });
    expect(missingWallet.status).toBe(404);
    expect(missingWallet.body.error.code).toBe('WALLET_NOT_FOUND');

    const byId = await api.get(`/wagering/transactions/${bet.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ kind: 'BET', status: 'PROCESSED', externalTransactionId: 'bet-1', balanceAfter: { amount: '20.00' } });
    const byProvider = await api.get(`/providers/provider-a/wagering/transactions/bet-2`);
    expect(byProvider.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
    expect((await api.get(`/providers/provider-a/wagering/transactions/ghost`)).status).toBe(404);
    await assertWalletConsistent(walletId);
  });

  it('ledger: cursor opaco e estável, páginas sem sobreposição', async () => {
    const playerId = uuid();
    const walletId = (await api.createWallet(playerId, '100.00')).body.id;
    for (let i = 0; i < 7; i++) {
      await api.submit({ externalTransactionId: `w-${i}`, playerId, walletId, kind: 'WIN', amount: '1.00', roundId: `r${i}` });
    }
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await api.get(`/wallets/${walletId}/ledger?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((e: { walletVersion: number }) => e.walletVersion));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(pages).toBe(3);
    expect((await api.get(`/wallets/${walletId}/ledger?cursor=garbage`)).status).toBe(400);
    expect((await api.get(`/wallets/${walletId}/ledger?limit=0`)).status).toBe(400);
  });

  it('reconciliação: consistente, e divergência é sinalizada sem correção', async () => {
    const playerId = uuid();
    const walletId = (await api.createWallet(playerId, '50.00')).body.id;
    await api.submit({ externalTransactionId: 'b', playerId, walletId, kind: 'BET', amount: '20.00' });
    const ok = await api.post(`/wallets/${walletId}/reconciliation`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({
      walletId,
      storedBalance: { amount: '30.00', currency: 'BRL' },
      calculatedBalance: { amount: '30.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
      issues: [],
    });
    // corrompe o saldo por fora (o ledger é imutável, então mexe na wallet)
    const orm = await getOrm();
    await orm.em.fork().execute("UPDATE wallets SET balance_amount = '31.00' WHERE id = ?", [walletId]);
    const bad = await api.post(`/wallets/${walletId}/reconciliation`);
    expect(bad.body.consistent).toBe(false);
    expect(bad.body.difference).toEqual({ amount: '1.00', currency: 'BRL' });
    expect(bad.body.issues).toEqual(['BALANCE_MISMATCH']);
    const metrics = await fetch(`${app.url}/metrics`).then((r) => r.text());
    expect(metrics).toMatch(/wallet_reconciliation_divergences_total 1/);
    // e o saldo continua como estava: ninguém "corrigiu" por baixo dos panos
    expect((await api.get(`/wallets/${walletId}`)).body.balance.amount).toBe('31.00');
  });

  it('correlationId: ecoa o header ou gera um', async () => {
    const res = await fetch(`${app.url}/health/live`, { headers: { 'x-correlation-id': 'my-corr' } });
    expect(res.headers.get('x-correlation-id')).toBe('my-corr');
    const res2 = await fetch(`${app.url}/wallets/${uuid()}`);
    expect(res2.headers.get('x-correlation-id')).toBeTruthy();
    const body = (await res2.json()) as { correlationId: string };
    expect(body.correlationId).toBe(res2.headers.get('x-correlation-id') ?? '');
  });

  it('métricas Prometheus expostas', async () => {
    const text = await fetch(`${app.url}/metrics`).then((r) => r.text());
    for (const name of ['wager_transactions_total', 'wager_idempotent_replays_total', 'wallet_lock_conflicts_total', 'outbox_lag_seconds', 'wager_processing_duration_seconds', 'sqs_dead_lettered_total', 'outbox_pending_messages']) {
      expect(text).toContain(name);
    }
  });
});

describe('autenticação OIDC (AUTH_MODE=oidc)', () => {
  let app: BootstrappedApp;
  let api: ApiClient;
  let jwks: ReturnType<typeof Bun.serve>;
  let privateKey: CryptoKey;
  const issuer = 'http://idp.test/realms/wagering';

  beforeAll(async () => {
    await getOrm();
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const publicJwk = await exportJWK(pair.publicKey);
    // JWKS fake: faz o papel do endpoint /protocol/openid-connect/certs do Keycloak
    jwks = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [{ ...publicJwk, kid: 'k1', alg: 'RS256', use: 'sig' }] }) });
    app = await startApp(
      { AUTH_MODE: 'oidc', AUTH_ISSUER: issuer, AUTH_JWKS_URL: `http://127.0.0.1:${jwks.port}/certs`, AUTH_AUDIENCE: 'wagering-processor', ENABLE_SQS_CONSUMER: 'false', ENABLE_OUTBOX_PUBLISHER: 'false', ENABLE_PENDING_REFERENCE_WORKER: 'false' },
      'auth',
    );
    api = new ApiClient(app.url);
  });
  afterAll(async () => {
    await app.close();
    jwks.stop(true);
    await deleteQueues([]);
    await closeOrm();
  });

  async function token(providerId: string, overrides: Record<string, unknown> = {}) {
    return new SignJWT({ azp: providerId, ...overrides })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(issuer)
      .setAudience('wagering-processor')
      .setSubject(`service-account-${providerId}`)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  }

  it('health continua aberto; endpoints de negócio exigem token', async () => {
    expect((await api.get('/health/live')).status).toBe(200);
    const res = await api.get(`/wallets/${uuid()}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('token válido passa; providerId do payload precisa bater com o token', async () => {
    const good = await token('provider-a');
    const playerId = uuid();
    const created = await api.post('/wallets', { playerId, initialBalance: { amount: '10.00', currency: 'BRL' } }, { authorization: `Bearer ${good}` });
    expect(created.status).toBe(201);
    const ok = await api.submit({ externalTransactionId: 'a1', playerId, walletId: created.body.id, kind: 'BET', amount: '1.00' }, { authorization: `Bearer ${good}` });
    expect(ok.status).toBe(200);
    const mismatch = await api.submit({ providerId: 'provider-b', externalTransactionId: 'a2', playerId, walletId: created.body.id, kind: 'BET', amount: '1.00' }, { authorization: `Bearer ${good}` });
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.error.code).toBe('PROVIDER_MISMATCH');
    expect((await api.get(`/providers/provider-b/wagering/transactions/a1`, )).status).toBe(401);
    const otherProvider = await fetch(`${app.url}/providers/provider-b/wagering/transactions/a1`, { headers: { authorization: `Bearer ${good}` } });
    expect(otherProvider.status).toBe(403);
  });

  it('token com issuer/audience errados ou expirado é rejeitado', async () => {
    const wrongIssuer = await new SignJWT({ azp: 'provider-a' }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer('http://evil').setAudience('wagering-processor').setExpirationTime('5m').sign(privateKey);
    expect((await api.post('/wallets', {}, { authorization: `Bearer ${wrongIssuer}` })).status).toBe(401);
    const expired = await new SignJWT({ azp: 'provider-a' }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(issuer).setAudience('wagering-processor').setExpirationTime(Math.floor(Date.now() / 1000) - 60).sign(privateKey);
    expect((await api.post('/wallets', {}, { authorization: `Bearer ${expired}` })).status).toBe(401);
    expect((await api.post('/wallets', {}, { authorization: `Bearer nonsense` })).status).toBe(401);
    expect((await api.post('/wallets', {}, { authorization: `Basic abc` })).status).toBe(401);
  });
});
