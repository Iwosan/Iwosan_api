import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MarketplaceListing } from './entities/marketplace-listing.entity';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceQuotesController } from './marketplace-quotes.controller';
import { MarketplaceQuotesService } from './marketplace-quotes.service';
import { MarketplaceService } from './marketplace.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([MarketplaceListing]),
    HttpModule.register({ timeout: 10000, maxRedirects: 5 }),
  ],
  controllers: [MarketplaceController, MarketplaceQuotesController],
  providers: [MarketplaceService, MarketplaceQuotesService],
  exports: [MarketplaceService, MarketplaceQuotesService],
})
export class MarketplaceModule {}
