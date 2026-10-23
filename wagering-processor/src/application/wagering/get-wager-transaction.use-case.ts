import { Injectable } from '@nestjs/common';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { UnitOfWork } from '../ports/repositories';
import { TransactionNotFoundError } from '../shared/errors';

@Injectable()
export class GetWagerTransactionUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async byId(transactionId: string): Promise<WagerTransaction> {
    const tx = await this.uow.read((repos) => repos.transactions.findById(transactionId));
    if (!tx) throw new TransactionNotFoundError({ transactionId });
    return tx;
  }

  async byProvider(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const tx = await this.uow.read((repos) =>
      repos.transactions.findByProviderAndExternalId(providerId, externalTransactionId),
    );
    if (!tx) throw new TransactionNotFoundError({ providerId, externalTransactionId });
    return tx;
  }
}
