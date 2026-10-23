import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { OpenWalletUseCase } from '../../../application/wallets/open-wallet.use-case';
import { ReconcileWalletUseCase } from '../../../application/wallets/reconcile-wallet.use-case';
import { WalletQueriesUseCase } from '../../../application/wallets/wallet-queries.use-case';
import { currentCorrelationId } from '../correlation.middleware';
import { ProviderAuthGuard } from '../auth/provider-auth.guard';
import { type LedgerQueryDto, type OpenWalletDto, ledgerQuerySchema, openWalletSchema } from '../dto/schemas';
import { presentLedgerEntry, presentWallet } from '../presenters';
import { ZodValidationPipe } from '../zod-validation.pipe';

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWalletUseCase,
    private readonly queries: WalletQueriesUseCase,
    private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body(new ZodValidationPipe(openWalletSchema)) body: OpenWalletDto) {
    const wallet = await this.openWallet.execute(body, { correlationId: currentCorrelationId() });
    return presentWallet(wallet);
  }

  @Get(':walletId')
  async get(@Param('walletId', ParseUUIDPipe) walletId: string) {
    return presentWallet(await this.queries.getWallet(walletId));
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Query(new ZodValidationPipe(ledgerQuerySchema)) query: LedgerQueryDto,
  ) {
    const page = await this.queries.getLedger(walletId, query.cursor, query.limit);
    return { items: page.entries.map(presentLedgerEntry), nextCursor: page.nextCursor };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconciliation(@Param('walletId', ParseUUIDPipe) walletId: string) {
    return this.reconcile.execute(walletId, { correlationId: currentCorrelationId() });
  }
}
