import { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../src/domain/money/money';
import { buildOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { TEST_DATABASE_URL } from './env';

let orm: MikroORM | null = null;

/** ORM do banco de teste, com migrations aplicadas. Memoizado por processo. */
export async function getOrm(): Promise<MikroORM> {
  if (!orm) {
    orm = await MikroORM.init(buildOrmConfig({ clientUrl: TEST_DATABASE_URL, poolMax: 5 }));
    await orm.getMigrator().up();
  }
  return orm;
}

export async function closeOrm(): Promise<void> {
  if (orm) {
    await orm.close(true);
    orm = null;
  }
}

export async function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
  const o = await getOrm();
  return o.em.fork({ useContext: false }).execute<T[]>(query, params);
}

export async function truncateAll(): Promise<void> {
  // Ordem importa por causa das FKs; os triggers de imutabilidade não cobrem TRUNCATE.
  await sql('TRUNCATE TABLE wallet_ledger_entries, wager_transactions, wallets, inbox_messages, outbox_messages CASCADE');
}

export interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance_amount: string;
  version: number;
}

export async function walletRow(walletId: string): Promise<WalletRow> {
  const [row] = await sql<WalletRow>('SELECT id, player_id, currency, balance_amount, version FROM wallets WHERE id = ?', [walletId]);
  if (!row) throw new Error(`wallet ${walletId} not found`);
  return row;
}

export async function ledgerRows(walletId: string) {
  return sql<{ direction: string; amount: string; balance_before: string; balance_after: string; wallet_version: number; transaction_id: string }>(
    'SELECT direction, amount, balance_before, balance_after, wallet_version, transaction_id FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY wallet_version',
    [walletId],
  );
}

export async function transactionRows(walletId: string) {
  return sql<{ id: string; external_transaction_id: string; kind: string; status: string; failure_code: string | null }>(
    'SELECT id, external_transaction_id, kind, status, failure_code FROM wager_transactions WHERE wallet_id = ? ORDER BY created_at',
    [walletId],
  );
}

export async function outboxRows(where = '') {
  return sql<{ id: string; event_type: string; aggregate_id: string; attempts: number; published_at: Date | null; payload: Record<string, unknown> }>(
    `SELECT id, event_type, aggregate_id, attempts, published_at, payload FROM outbox_messages ${where} ORDER BY occurred_at`,
  );
}

/**
 * A invariante final de todos os testes: wallet.balance == saldo reconstruído pelo
 * ledger, com a cadeia balanceBefore/balanceAfter fechada e a versão batendo.
 */
export async function assertWalletConsistent(walletId: string): Promise<{ balance: string; entries: number }> {
  const wallet = await walletRow(walletId);
  const entries = await ledgerRows(walletId);
  let running = Money.zero(wallet.currency);
  let previousAfter = Money.zero(wallet.currency);
  for (const e of entries) {
    const money = Money.from({ amount: e.amount, currency: wallet.currency });
    const before = Money.from({ amount: e.balance_before, currency: wallet.currency });
    const after = Money.from({ amount: e.balance_after, currency: wallet.currency });
    if (!before.equals(previousAfter)) {
      throw new Error(`broken ledger chain at version ${e.wallet_version}: before=${before} expected=${previousAfter}`);
    }
    running = e.direction === 'CREDIT' ? running.add(money) : running.subtract(money);
    if (!running.equals(after)) {
      throw new Error(`unbalanced entry at version ${e.wallet_version}: after=${after} expected=${running}`);
    }
    previousAfter = after;
  }
  const stored = Money.from({ amount: wallet.balance_amount, currency: wallet.currency });
  if (!stored.equals(running)) {
    throw new Error(`wallet ${walletId}: stored ${stored} != ledger ${running}`);
  }
  if (stored.isNegative()) {
    throw new Error(`wallet ${walletId} is negative: ${stored}`);
  }
  const expectedVersion = entries.length > 0 ? entries[entries.length - 1]!.wallet_version : 1;
  if (wallet.version !== expectedVersion) {
    throw new Error(`wallet ${walletId}: version ${wallet.version} != last ledger version ${expectedVersion}`);
  }
  return { balance: stored.amount, entries: entries.length };
}
