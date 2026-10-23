import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';

// Portas de persistência. Todas as operações rodam dentro do UnitOfWork atual:
// os repositórios recebidos em `uow.run(repos => ...)` compartilham a mesma
// transação SQL.

export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;
  /** SELECT ... FOR UPDATE — serializa tudo que toca esta wallet. */
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  /** Lança WalletAlreadyExistsError se (playerId, currency) já existir. */
  insert(wallet: Wallet): Promise<void>;
  /**
   * UPDATE condicionado por versão. Lança WalletVersionConflictError se a linha
   * não estiver mais na versão esperada (lost update detectado).
   */
  update(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdForUpdate(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  /** Já existe REFUND/ROLLBACK PROCESSED apontando para esta transação? */
  hasProcessedReversalOf(referenceTransactionId: string): Promise<boolean>;
  insert(tx: WagerTransaction): Promise<void>;
  update(tx: WagerTransaction): Promise<void>;
  /** Antecipa o retry de quem está esperando por (providerId, externalTransactionId). */
  wakeUpWaitingReferences(providerId: string, externalTransactionId: string, now: Date): Promise<number>;
  /**
   * Reserva até `limit` transações PENDING_REFERENCE vencidas (SKIP LOCKED) e
   * empurra o nextRetryAt para `now + leaseMs`, para outra instância não pegar
   * as mesmas enquanto esta processa. Retorna os ids reservados.
   */
  claimDuePendingReferences(now: Date, limit: number, leaseMs: number): Promise<string[]>;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** walletVersion do último item, para montar o próximo cursor. */
  lastVersion: number | null;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  /** Ordenado por walletVersion; `afterVersion` é o cursor (exclusivo). */
  listByWallet(walletId: string, afterVersion: number, limit: number): Promise<LedgerPage>;
}

export interface InboxRepository {
  /** INSERT ... ON CONFLICT DO NOTHING. Retorna false se já existia. */
  tryInsert(message: InboxMessage): Promise<boolean>;
  update(message: InboxMessage): Promise<void>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;
}

export interface OutboxStats {
  pending: number;
  oldestPendingOccurredAt: Date | null;
}

export interface OutboxRepository {
  enqueue(messages: OutboxMessage[]): Promise<void>;
  /** FOR UPDATE SKIP LOCKED: publishers concorrentes nunca pegam a mesma linha. */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  update(message: OutboxMessage): Promise<void>;
  stats(): Promise<OutboxStats>;
}

export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export type IsolationLevel = 'READ COMMITTED' | 'REPEATABLE READ';

export interface UnitOfWorkOptions {
  isolation?: IsolationLevel;
  /** Tempo máximo esperando lock de linha. Estourou → TransientInfrastructureError. */
  lockTimeoutMs?: number;
}

/**
 * Uma transação SQL por `run`. Erros do driver são traduzidos para
 * Transient/PermanentInfrastructureError antes de sair daqui.
 */
export abstract class UnitOfWork {
  abstract run<T>(work: (repos: Repositories) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
  /** Leituras fora de transação explícita (autocommit). */
  abstract read<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}
