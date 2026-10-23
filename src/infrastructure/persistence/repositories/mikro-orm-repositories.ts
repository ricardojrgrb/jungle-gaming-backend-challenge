import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import {
  type InboxRepository,
  type LedgerPage,
  type LedgerRepository,
  type OutboxRepository,
  type OutboxStats,
  type WagerTransactionRepository,
  type WalletRepository,
} from '../../../application/ports/repositories';
import { WalletVersionConflictError } from '../../../application/shared/errors';
import { InboxMessage } from '../../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../../domain/messaging/outbox-message';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../../domain/wagering/wager-transaction';
import { Wallet } from '../../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry';
import {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from '../entities/records';
import {
  inboxToDomain,
  ledgerToDomain,
  ledgerToRecord,
  outboxToDomain,
  transactionToDomain,
  transactionToRecord,
  walletToDomain,
  walletToRecord,
} from './mappers';

// Todos recebem o EntityManager da transação corrente (fork feito pelo UnitOfWork).
// Escolha deliberada: statements explícitos (insert/nativeUpdate/find com lock) em
// vez de persist+flush. No caminho financeiro eu quero enxergar a ordem exata dos
// writes e o UPDATE condicionado — Unit of Work implícito esconde isso.

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | null> {
    const r = await this.em.findOne(WalletRecord, { id });
    return r ? walletToDomain(r) : null;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    // SELECT ... FOR UPDATE: a unidade de concorrência é a wallet.
    const r = await this.em.findOne(WalletRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    return r ? walletToDomain(r) : null;
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletRecord, walletToRecord(wallet));
  }

  async update(wallet: Wallet, expectedVersion: number): Promise<void> {
    // Mesmo segurando o lock, o WHERE por versão é a prova de que não houve lost
    // update: se alguém mexeu na linha sem passar pelo lock, affected == 0.
    const affected = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      { balanceAmount: wallet.balance.amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) {
      throw new WalletVersionConflictError(wallet.id, expectedVersion);
    }
  }
}

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    const r = await this.em.findOne(WagerTransactionRecord, { id }, { refresh: true });
    return r ? transactionToDomain(r) : null;
  }

  async findByIdForUpdate(id: string): Promise<WagerTransaction | null> {
    const r = await this.em.findOne(WagerTransactionRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    return r ? transactionToDomain(r) : null;
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    const r = await this.em.findOne(WagerTransactionRecord, { idempotencyKey: key }, { refresh: true });
    return r ? transactionToDomain(r) : null;
  }

  async findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const r = await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId }, { refresh: true });
    return r ? transactionToDomain(r) : null;
  }

  async hasProcessedReversalOf(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    });
    return count > 0;
  }

  async insert(tx: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionRecord, transactionToRecord(tx, tx.createdAt));
  }

  async update(tx: WagerTransaction): Promise<void> {
    const { id: _id, createdAt: _createdAt, ...data } = transactionToRecord(tx, new Date());
    const affected = await this.em.nativeUpdate(WagerTransactionRecord, { id: tx.id }, data);
    if (affected !== 1) {
      throw new Error(`transaction ${tx.id} not found for update`);
    }
  }

  async wakeUpWaitingReferences(providerId: string, externalTransactionId: string, now: Date): Promise<number> {
    return this.em.nativeUpdate(
      WagerTransactionRecord,
      {
        status: WagerTransactionStatus.PendingReference,
        providerId,
        referenceExternalTransactionId: externalTransactionId,
        nextReferenceRetryAt: { $gt: now },
      },
      { nextReferenceRetryAt: now },
    );
  }

  async claimDuePendingReferences(now: Date, limit: number, leaseMs: number): Promise<string[]> {
    const lease = new Date(now.getTime() + leaseMs);
    const rows = await this.em.execute<{ id: string }[]>(
      `UPDATE wager_transactions
          SET next_reference_retry_at = ?, updated_at = ?
        WHERE id IN (
          SELECT id FROM wager_transactions
           WHERE status = 'PENDING_REFERENCE' AND next_reference_retry_at <= ?
           ORDER BY next_reference_retry_at
           LIMIT ?
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id`,
      [lease, now, now, limit],
    );
    return rows.map((r) => r.id);
  }
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRecord, ledgerToRecord(entry));
  }

  async listByWallet(walletId: string, afterVersion: number, limit: number): Promise<LedgerPage> {
    const rows = await this.em.find(
      LedgerEntryRecord,
      { walletId, walletVersion: { $gt: afterVersion } },
      { orderBy: { walletVersion: 'asc' }, limit, refresh: true },
    );
    const entries = rows.map(ledgerToDomain);
    const last = entries[entries.length - 1];
    return { entries, lastVersion: last ? last.walletVersion : null };
  }
}

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryInsert(message: InboxMessage): Promise<boolean> {
    // Duplicata em voo: o INSERT espera o outro commitar e então "DO NOTHING".
    const rows = await this.em.execute<{ message_id: string }[]>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt, message.processedAt ?? null],
    );
    return rows.length === 1;
  }

  async update(message: InboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      InboxMessageRecord,
      { consumerName: message.consumerName, messageId: message.messageId },
      { processedAt: message.processedAt ?? null },
    );
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const r = await this.em.findOne(InboxMessageRecord, { consumerName, messageId }, { refresh: true });
    return r ? inboxToDomain(r) : null;
  }
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(
      OutboxMessageRecord,
      messages.map((m) =>
        Object.assign(new OutboxMessageRecord(), {
          id: m.id,
          aggregateId: m.aggregateId,
          eventType: m.eventType,
          payload: m.payload,
          occurredAt: m.occurredAt,
          attempts: m.attempts,
          nextAttemptAt: m.nextAttemptAt ?? null,
          publishedAt: m.publishedAt ?? null,
          createdAt: new Date(),
        }),
      ),
    );
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = await this.em.find(
      OutboxMessageRecord,
      { publishedAt: null, $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
      {
        orderBy: { occurredAt: 'asc', id: 'asc' },
        limit,
        // FOR UPDATE SKIP LOCKED
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        refresh: true,
      },
    );
    return rows.map(outboxToDomain);
  }

  async update(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageRecord,
      { id: message.id },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? null,
        publishedAt: message.publishedAt ?? null,
      },
    );
  }

  async stats(): Promise<OutboxStats> {
    const [row] = await this.em.execute<{ pending: string; oldest: Date | null }[]>(
      `SELECT count(*)::text AS pending, min(occurred_at) AS oldest FROM outbox_messages WHERE published_at IS NULL`,
    );
    return { pending: Number(row?.pending ?? 0), oldestPendingOccurredAt: row?.oldest ?? null };
  }
}
