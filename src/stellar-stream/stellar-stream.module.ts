import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Record } from '../records/entities/record.entity';
import { AccessGrant } from '../access-control/entities/access-grant.entity';
import { MarketplaceModule } from '../marketplace/marketplace.module';
import { StellarStreamService } from './stellar-stream.service';
import { MarketplaceEventStreamService } from './marketplace-event-stream.service';
import { StellarStreamHealthIndicator } from './stellar-stream.health';
import { StellarStreamEventsCounter } from './stellar-stream.metrics';

@Module({
  imports: [
    TypeOrmModule.forFeature([Record, AccessGrant]),
    EventEmitterModule.forRoot(),
    MarketplaceModule,
  ],
  providers: [
    StellarStreamService,
    MarketplaceEventStreamService,
    StellarStreamHealthIndicator,
    StellarStreamEventsCounter,
  ],
  exports: [StellarStreamService, MarketplaceEventStreamService, StellarStreamHealthIndicator],
})
export class StellarStreamModule {}
