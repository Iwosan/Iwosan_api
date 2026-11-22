import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnchorController } from './anchor.controller';
import { AnchorService } from './anchor.service';
import { AnchorTransactionPoller } from './anchor-transaction.poller';
import { AnchorTransaction } from './entities/anchor-transaction.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([AnchorTransaction]),
    HttpModule.register({ timeout: 15000, maxRedirects: 5 }),
    ScheduleModule.forRoot(),
  ],
  controllers: [AnchorController],
  providers: [AnchorService, AnchorTransactionPoller],
  exports: [AnchorService],
})
export class AnchorModule {}
