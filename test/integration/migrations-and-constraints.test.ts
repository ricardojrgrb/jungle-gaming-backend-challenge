import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { closeOrm, getOrm, sql, truncateAll } from '../helpers/db';

const uuid = () => crypto.randomUUID();
const now = new Date();

async function insertWallet(balance = '100.00', version = 1) {
  const id = uuid();
  await sql('INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, uuid(), 'BRL', balance, version, now, now]);
  return id;
}

async function insertTransaction(walletId: string, overrides: Record<string, unknown> = {}) {
  const id = uuid();
  const row = {
    id,
    provider_id: 'p',
    external_transaction_id: uuid(),
    idempotency_key: uuid(),
    payload_hash: 'h'.repeat(64),
    wallet_id: walletId,
    player_id: uuid(),
    round_id: 'r',
    game_id: 'g',
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
    reference_external_transaction_id: null,
    reference_transaction_id: null,
    status: 'PROCESSED',
    failure_code: null,
    balance_after_amount: '90.00',
    reference_attempts: 0,
    next_reference_retry_at: null,
    created_at: now,
    processed_at: now,
    updated_at: now,
    ...overrides,
  };
  const cols = Object.keys(row);
  await sql(`INSERT INTO wager_transactions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, Object.values(row));
  return id;
}

async function insertLedger(walletId: string, txId: string, overrides: Record<string, unknown> = {}) {
  const row = {
    id: uuid(),
    wallet_id: walletId,
    transaction_id: txId,
    wallet_version: 2,
    direction: 'DEBIT',
    amount: '10.00',
    currency: 'BRL',
    balance_before: '100.00',
    balance_after: '90.00',
    created_at: now,
    ...overrides,
  };
  const cols = Object.keys(row);
  await sql(`INSERT INTO wallet_ledger_entries (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, Object.values(row));
  return row.id;
}

describe('migrations', () => {
  beforeAll(async () => {
    await getOrm();
    await truncateAll();
  });
  afterAll(closeOrm);

  it('são versionadas e reversíveis: down remove tudo, up recria', async () => {
    const orm = await getOrm();
    const migrator = orm.getMigrator();
    expect((await migrator.getPendingMigrations()).length).toBe(0);
    await migrator.down();
    const after = await sql<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'mikro_orm_migrations'");
    expect(after.map((r) => r.table_name)).toEqual([]);
    await migrator.up();
    const tables = await sql<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name");
    expect(tables.map((r) => r.table_name)).toEqual(['inbox_messages', 'mikro_orm_migrations', 'outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets']);
  });
});

describe('constraints no schema', () => {
  beforeAll(async () => {
    await getOrm();
    await truncateAll();
  });
  afterAll(closeOrm);

  it('wallet: uma por (player, currency); saldo não negativo; version >= 1; moeda ISO', async () => {
    const playerId = uuid();
    await sql('INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [uuid(), playerId, 'BRL', '0.00', 1, now, now]);
    await expect(sql('INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [uuid(), playerId, 'BRL', '0.00', 1, now, now])).rejects.toThrow(/wallets_player_currency_unique/);
    // outra moeda para o mesmo player é permitido (modelo multi-moeda)
    await sql('INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [uuid(), playerId, 'USD', '0.00', 1, now, now]);

    const id = await insertWallet('10.00');
    await expect(sql('UPDATE wallets SET balance_amount = balance_amount - 10.01 WHERE id = ?', [id])).rejects.toThrow(/wallets_balance_non_negative/);
    await expect(sql('UPDATE wallets SET version = 0 WHERE id = ?', [id])).rejects.toThrow(/wallets_version_positive/);
    await expect(insertWalletWithCurrency('brl')).rejects.toThrow(/wallets_currency_iso4217/);
  });

  async function insertWalletWithCurrency(currency: string) {
    await sql('INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [uuid(), uuid(), currency, '0.00', 1, now, now]);
  }

  it('ledger: imutável (UPDATE e DELETE barrados por trigger)', async () => {
    const w = await insertWallet();
    const tx = await insertTransaction(w);
    const entryId = await insertLedger(w, tx);
    await expect(sql('UPDATE wallet_ledger_entries SET amount = 1 WHERE id = ?', [entryId])).rejects.toThrow(/immutable/);
    await expect(sql('DELETE FROM wallet_ledger_entries WHERE id = ?', [entryId])).rejects.toThrow(/immutable/);
    const [row] = await sql<{ amount: string }>('SELECT amount FROM wallet_ledger_entries WHERE id = ?', [entryId]);
    expect(row!.amount).toBe('10.00');
  });

  it('ledger: aritmética, unicidade por transação e por (wallet, version), saldos não negativos', async () => {
    const w = await insertWallet();
    const tx = await insertTransaction(w);
    await insertLedger(w, tx);
    // no máximo um lançamento por transação
    await expect(insertLedger(w, tx, { wallet_version: 3 })).rejects.toThrow(/wallet_ledger_entries_transaction_unique/);
    const tx2 = await insertTransaction(w);
    // mesma versão da wallet duas vezes
    await expect(insertLedger(w, tx2, { wallet_version: 2 })).rejects.toThrow(/wallet_ledger_entries_wallet_version_unique/);
    // aritmética errada
    await expect(insertLedger(w, tx2, { wallet_version: 3, balance_after: '91.00' })).rejects.toThrow(/wallet_ledger_entries_arithmetic/);
    await expect(insertLedger(w, tx2, { wallet_version: 3, direction: 'CREDIT' })).rejects.toThrow(/wallet_ledger_entries_arithmetic/);
    // saldo negativo
    await expect(insertLedger(w, tx2, { wallet_version: 3, balance_before: '5.00', balance_after: '-5.00' })).rejects.toThrow(/non_negative/);
    await expect(insertLedger(w, tx2, { wallet_version: 3, amount: '0.00', balance_after: '100.00' })).rejects.toThrow(/amount_positive/);
    await expect(insertLedger(w, tx2, { wallet_version: 3, direction: 'SIDEWAYS' })).rejects.toThrow(/direction_check|arithmetic/);
  });

  it('transação: unicidade de (provider, externalId) e de idempotency key', async () => {
    const w = await insertWallet();
    await insertTransaction(w, { external_transaction_id: 'ext-1', idempotency_key: 'k-1' });
    await expect(insertTransaction(w, { external_transaction_id: 'ext-1', idempotency_key: 'k-2' })).rejects.toThrow(/wager_transactions_provider_external_unique/);
    await expect(insertTransaction(w, { external_transaction_id: 'ext-2', idempotency_key: 'k-1' })).rejects.toThrow(/wager_transactions_idempotency_key_unique/);
  });

  it('transação: estados terminais são imutáveis e append-only', async () => {
    const w = await insertWallet();
    const processed = await insertTransaction(w);
    await expect(sql("UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'X', processed_at = NULL WHERE id = ?", [processed])).rejects.toThrow(/terminal/);
    await expect(sql("UPDATE wager_transactions SET amount = 1 WHERE id = ?", [processed])).rejects.toThrow(/terminal/);
    await expect(sql('DELETE FROM wager_transactions WHERE id = ?', [processed])).rejects.toThrow(/append-only/);
    // não terminal pode transicionar
    const pending = await insertTransaction(w, { status: 'PENDING', processed_at: null, balance_after_amount: null });
    await sql("UPDATE wager_transactions SET status = 'PROCESSED', processed_at = now(), balance_after_amount = '1.00' WHERE id = ?", [pending]);
  });

  it('transação: coerência entre status, failure_code, processed_at e saldo observado', async () => {
    const w = await insertWallet();
    await expect(insertTransaction(w, { status: 'REJECTED', failure_code: null, processed_at: null })).rejects.toThrow(/failure_code_matches_status/);
    await expect(insertTransaction(w, { status: 'PROCESSED', failure_code: 'INSUFFICIENT_FUNDS' })).rejects.toThrow(/failure_code_matches_status/);
    await expect(insertTransaction(w, { status: 'PROCESSED', processed_at: null })).rejects.toThrow(/processed_at_matches_status/);
    await expect(insertTransaction(w, { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS', processed_at: null, balance_after_amount: null })).rejects.toThrow(/observed_balance/);
    await expect(insertTransaction(w, { kind: 'REFUND', reference_external_transaction_id: null })).rejects.toThrow(/reversal_has_reference/);
    await expect(insertTransaction(w, { kind: 'SPLIT' })).rejects.toThrow(/kind_check/);
    await expect(insertTransaction(w, { amount: '0.00' })).rejects.toThrow(/amount_positive/);
  });

  it('uma referência só pode ter uma reversão PROCESSED (índice único parcial)', async () => {
    const w = await insertWallet();
    const bet = await insertTransaction(w, { external_transaction_id: 'bet' });
    await insertTransaction(w, { kind: 'REFUND', reference_external_transaction_id: 'bet', reference_transaction_id: bet });
    await expect(insertTransaction(w, { kind: 'ROLLBACK', reference_external_transaction_id: 'bet', reference_transaction_id: bet })).rejects.toThrow(/one_reversal_per_reference/);
    // uma reversão REJECTED não ocupa o slot
    await insertTransaction(w, { kind: 'ROLLBACK', reference_external_transaction_id: 'bet', reference_transaction_id: bet, status: 'REJECTED', failure_code: 'REFERENCE_ALREADY_REVERSED', processed_at: null });
  });

  it('inbox: chave primária composta (consumer, messageId)', async () => {
    await sql('INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at) VALUES (?, ?, ?, ?)', ['c1', 'm1', 'h'.repeat(64), now]);
    await expect(sql('INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at) VALUES (?, ?, ?, ?)', ['c1', 'm1', 'h'.repeat(64), now])).rejects.toThrow(/inbox_messages_pkey/);
    await sql('INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at) VALUES (?, ?, ?, ?)', ['c2', 'm1', 'h'.repeat(64), now]);
  });
});
