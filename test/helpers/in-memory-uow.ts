import type {
  InboxRepository,
  LedgerPage,
  LedgerRepository,
  OutboxRepository,
  Repositories,
  UnitOfWorkOptions,
  WagerTransactionRepository,
  WalletRepository,
} from '../../src/application/ports/repositories';
import { UnitOfWork } from '../../src/application/ports/repositories';
import { WalletAlreadyExistsError, WalletVersionConflictError } from '../../src/application/shared/errors';
import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../src/domain/wallet/wallet';
import { WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger-entry';

/**
 * UnitOfWork em memória para testes de unidade do use case. Sem locks, sem
 * concorrência — só as regras. Snapshots para simular rollback quando `run` lança.
 */
export class InMemoryUnitOfWork extends UnitOfWork {
  wallets = new Map<string, Wallet>();
  transactions = new Map<string, WagerTransaction>();
  ledger: WalletLedgerEntry[] = [];
  inbox = new Map<string, InboxMessage>();
  outbox: OutboxMessage[] = [];

  private snapshot() {
    return {
      wallets: new Map([...this.wallets].map(([k, w]) => [k, Wallet.rehydrate({ id: w.id, playerId: w.playerId, currency: w.currency, balance: w.balance, version: w.version, createdAt: w.createdAt, updatedAt: w.updatedAt })])),
      transactions: new Map(this.transactions),
      ledger: [...this.ledger],
      inbox: new Map(this.inbox),
      outbox: [...this.outbox],
    };
  }

  async run<T>(work: (repos: Repositories) => Promise<T>, _options?: UnitOfWorkOptions): Promise<T> {
    const snap = this.snapshot();
    try {
      return await work(this.repos());
    } catch (error) {
      Object.assign(this, snap);
      throw error;
    }
  }

  async read<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    return work(this.repos());
  }

  private repos(): Repositories {
    const self = this;
    const wallets: WalletRepository = {
      async findById(id) {
        return self.wallets.get(id) ?? null;
      },
      async findByIdForUpdate(id) {
        return self.wallets.get(id) ?? null;
      },
      async insert(wallet) {
        for (const w of self.wallets.values()) {
          if (w.playerId === wallet.playerId && w.currency === wallet.currency) throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
        }
        self.wallets.set(wallet.id, wallet);
      },
      async update(wallet, expectedVersion) {
        const current = self.wallets.get(wallet.id);
        if (!current || (current !== wallet && current.version !== expectedVersion)) throw new WalletVersionConflictError(wallet.id, expectedVersion);
        self.wallets.set(wallet.id, wallet);
      },
    };
    const transactions: WagerTransactionRepository = {
      async findById(id) {
        return self.transactions.get(id) ?? null;
      },
      async findByIdForUpdate(id) {
        return self.transactions.get(id) ?? null;
      },
      async findByIdempotencyKey(key) {
        return [...self.transactions.values()].find((t) => t.idempotencyKey === key) ?? null;
      },
      async findByProviderAndExternalId(providerId, ext) {
        return [...self.transactions.values()].find((t) => t.providerId === providerId && t.externalTransactionId === ext) ?? null;
      },
      async hasProcessedReversalOf(refId) {
        return [...self.transactions.values()].some(
          (t) => t.referenceTransactionId === refId && t.status === WagerTransactionStatus.Processed && (t.kind === WagerTransactionKind.Refund || t.kind === WagerTransactionKind.Rollback),
        );
      },
      async insert(tx) {
        self.transactions.set(tx.id, tx);
      },
      async update(tx) {
        self.transactions.set(tx.id, tx);
      },
      async wakeUpWaitingReferences() {
        return 0;
      },
      async claimDuePendingReferences(now, limit) {
        return [...self.transactions.values()]
          .filter((t) => t.status === WagerTransactionStatus.PendingReference && t.nextReferenceRetryAt && t.nextReferenceRetryAt <= now)
          .slice(0, limit)
          .map((t) => t.id);
      },
    };
    const ledger: LedgerRepository = {
      async insert(entry) {
        self.ledger.push(entry);
      },
      async listByWallet(walletId, afterVersion, limit): Promise<LedgerPage> {
        const entries = self.ledger.filter((e) => e.walletId === walletId && e.walletVersion > afterVersion).sort((a, b) => a.walletVersion - b.walletVersion).slice(0, limit);
        return { entries, lastVersion: entries.length ? entries[entries.length - 1]!.walletVersion : null };
      },
    };
    const inbox: InboxRepository = {
      async tryInsert(message) {
        const key = `${message.consumerName}:${message.messageId}`;
        if (self.inbox.has(key)) return false;
        self.inbox.set(key, message);
        return true;
      },
      async update() {},
      async find(consumerName, messageId) {
        return self.inbox.get(`${consumerName}:${messageId}`) ?? null;
      },
    };
    const outbox: OutboxRepository = {
      async enqueue(messages) {
        self.outbox.push(...messages);
      },
      async claimDue(now, limit) {
        return self.outbox.filter((m) => m.isDue(now)).slice(0, limit);
      },
      async update() {},
      async stats() {
        const pending = self.outbox.filter((m) => m.isPending());
        return { pending: pending.length, oldestPendingOccurredAt: pending[0]?.occurredAt ?? null };
      },
    };
    return { wallets, transactions, ledger, inbox, outbox };
  }
}
