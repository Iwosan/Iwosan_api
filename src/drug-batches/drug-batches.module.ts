import { Module } from '@nestjs/common';
import { DrugBatchContractReader } from './drug-batch-contract.reader';
import { DrugBatchesController } from './drug-batches.controller';
import { DrugBatchesService } from './drug-batches.service';

@Module({
  controllers: [DrugBatchesController],
  providers: [DrugBatchesService, DrugBatchContractReader],
  exports: [DrugBatchesService, DrugBatchContractReader],
})
export class DrugBatchesModule {}
