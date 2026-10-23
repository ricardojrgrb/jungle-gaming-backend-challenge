import { Injectable } from '@nestjs/common';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { UnitOfWork } from '../ports/repositories';
import { ValidationError, WalletNotFoundError } from '../shared/errors';

export interface LedgerPageResult {
  entries: WalletLedgerEntry[];
  nextCursor: string | null;
}

/**
 * Cursor opaco: base64url de {"v": walletVersion}. Estável porque walletVersion é
 * única e crescente por wallet, e o ledger nunca muda — uma página lida hoje é a
 * mesma amanhã.
 */
export function encodeCursor(version: number): string {
  return Buffer.from(JSON.stringify({ v: version })).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown };
    if (typeof parsed.v !== 'number' || !Number.isInteger(parsed.v) || parsed.v < 0) {
      throw new Error('bad cursor');
    }
    return parsed.v;
  } catch {
    throw new ValidationError('invalid cursor', { cursor });
  }
}

@Injectable()
export class WalletQueriesUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async getWallet(walletId: string): Promise<Wallet> {
    const wallet = await this.uow.read((repos) => repos.wallets.findById(walletId));
    if (!wallet) throw new WalletNotFoundError(walletId);
    return wallet;
  }

  async getLedger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPageResult> {
    const afterVersion = decodeCursor(cursor);
    return this.uow.read(async (repos) => {
      const wallet = await repos.wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);
      // Pede um a mais para saber se há próxima página sem um COUNT.
      const page = await repos.ledger.listByWallet(walletId, afterVersion, limit + 1);
      const hasMore = page.entries.length > limit;
      const entries = hasMore ? page.entries.slice(0, limit) : page.entries;
      const last = entries[entries.length - 1];
      return { entries, nextCursor: hasMore && last ? encodeCursor(last.walletVersion) : null };
    });
  }
}
