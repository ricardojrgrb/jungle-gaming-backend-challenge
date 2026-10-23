import { Injectable } from '@nestjs/common';
import { EntityManager, IsolationLevel as OrmIsolationLevel, MikroORM } from '@mikro-orm/postgresql';
import { type Repositories, UnitOfWork, type UnitOfWorkOptions } from '../../application/ports/repositories';
import { translateDriverError } from './pg-errors';
import {
  MikroOrmInboxRepository,
  MikroOrmLedgerRepository,
  MikroOrmOutboxRepository,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletRepository,
} from './repositories/mikro-orm-repositories';

/**
 * Uma transação SQL por `run`. Cada chamada faz um fork do EntityManager (identity
 * map próprio, sem RequestContext mágico) e devolve repositórios amarrados nele.
 */
@Injectable()
export class MikroOrmUnitOfWork extends UnitOfWork {
  constructor(private readonly orm: MikroORM) {
    super();
  }

  async run<T>(work: (repos: Repositories) => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    const em = this.orm.em.fork({ useContext: false });
    try {
      return await em.transactional(
        async (tx) => {
          if (options.lockTimeoutMs !== undefined) {
            // SET LOCAL vale só para esta transação. Estourou → 55P03 → transitório.
            await tx.execute(`SET LOCAL lock_timeout = '${Math.floor(options.lockTimeoutMs)}ms'`);
          }
          return work(buildRepositories(tx));
        },
        {
          isolationLevel:
            options.isolation === 'REPEATABLE READ'
              ? OrmIsolationLevel.REPEATABLE_READ
              : OrmIsolationLevel.READ_COMMITTED,
        },
      );
    } catch (error) {
      throw translateDriverError(error);
    }
  }

  async read<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    const em = this.orm.em.fork({ useContext: false });
    try {
      return await work(buildRepositories(em));
    } catch (error) {
      throw translateDriverError(error);
    }
  }
}

export function buildRepositories(em: EntityManager): Repositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}
