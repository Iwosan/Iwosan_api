import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MarketplaceModule } from '../../marketplace/marketplace.module';
import { CrossBorderController } from './cross-border.controller';
import { CrossBorderPaymentPoller } from './cross-border.poller';
import { CrossBorderService } from './cross-border.service';
import { CrossBorderPayment } from './entities/cross-border-payment.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([CrossBorderPayment]),
    HttpModule.register({ timeout: 15000, maxRedirects: 5 }),
    ScheduleModule.forRoot(),
    MarketplaceModule,
  ],
  controllers: [CrossBorderController],
  providers: [CrossBorderService, CrossBorderPaymentPoller],
  exports: [CrossBorderService],
})
export class CrossBorderModule {}
