import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../auth/entities/user.entity';
import { MarketplaceListing } from './entities/marketplace-listing.entity';
import { MarketplaceOrder } from './entities/marketplace-order.entity';
import { MarketplaceReview } from './entities/marketplace-review.entity';
import { MarketplaceContractReader } from './marketplace-contract.reader';
import { MarketplaceOrdersController } from './marketplace-orders.controller';
import { MarketplaceOrdersService } from './marketplace-orders.service';
import { MarketplaceQuotesController } from './marketplace-quotes.controller';
import { MarketplaceQuotesService } from './marketplace-quotes.service';
import { MarketplaceReviewsService } from './marketplace-reviews.service';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';
import { PriceService } from './price.service';
import { ReflectorOracleClient } from './reflector-oracle.client';

@Module({
  imports: [
    TypeOrmModule.forFeature([MarketplaceListing, MarketplaceOrder, MarketplaceReview, User]),
    HttpModule.register({ timeout: 10000, maxRedirects: 5 }),
  ],
  controllers: [MarketplaceController, MarketplaceQuotesController, MarketplaceOrdersController],
  providers: [
    MarketplaceService,
    MarketplaceQuotesService,
    MarketplaceReviewsService,
    MarketplaceOrdersService,
    MarketplaceContractReader,
    PriceService,
    ReflectorOracleClient,
  ],
  exports: [
    MarketplaceService,
    MarketplaceQuotesService,
    MarketplaceReviewsService,
    MarketplaceOrdersService,
    MarketplaceContractReader,
    PriceService,
  ],
})
export class MarketplaceModule {}
