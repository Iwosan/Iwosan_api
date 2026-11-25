import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../auth/entities/user.entity';
import { MarketplaceListing } from './entities/marketplace-listing.entity';
import { MarketplaceOrder } from './entities/marketplace-order.entity';
import { MarketplaceContractReader } from './marketplace-contract.reader';
import { MarketplaceOrdersController } from './marketplace-orders.controller';
import { MarketplaceOrdersService } from './marketplace-orders.service';
import { MarketplaceQuotesController } from './marketplace-quotes.controller';
import { MarketplaceQuotesService } from './marketplace-quotes.service';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([MarketplaceListing, MarketplaceOrder, User]),
    HttpModule.register({ timeout: 10000, maxRedirects: 5 }),
  ],
  controllers: [MarketplaceController, MarketplaceQuotesController, MarketplaceOrdersController],
  providers: [
    MarketplaceService,
    MarketplaceQuotesService,
    MarketplaceOrdersService,
    MarketplaceContractReader,
  ],
  exports: [
    MarketplaceService,
    MarketplaceQuotesService,
    MarketplaceOrdersService,
    MarketplaceContractReader,
  ],
})
export class MarketplaceModule {}
