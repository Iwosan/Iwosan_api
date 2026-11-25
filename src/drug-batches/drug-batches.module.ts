import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../auth/entities/user.entity';
import { MarketplaceModule } from '../marketplace/marketplace.module';
import { NotificationOutboxEntry } from '../notifications/entities/notification-outbox.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { DrugBatchContractReader } from './drug-batch-contract.reader';
import { DrugBatchEventStreamService } from './drug-batch-event-stream.service';
import { DrugBatchesController } from './drug-batches.controller';
import { DrugBatchesService } from './drug-batches.service';
import { RecallAdminController } from './recall-admin.controller';
import { RecallNotificationsService } from './recall-notifications.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, NotificationOutboxEntry]),
    MarketplaceModule,
    NotificationsModule,
  ],
  controllers: [DrugBatchesController, RecallAdminController],
  providers: [
    DrugBatchesService,
    DrugBatchContractReader,
    RecallNotificationsService,
    DrugBatchEventStreamService,
  ],
  exports: [DrugBatchesService, DrugBatchContractReader, RecallNotificationsService],
})
export class DrugBatchesModule {}
