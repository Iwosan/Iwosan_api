import { IsIn, Matches } from 'class-validator';

export class ListOrdersQueryDto {
  /** Which side of the order the authenticated user is on. */
  @IsIn(['buyer', 'seller'])
  role: 'buyer' | 'seller';
}

export class AssignBatchDto {
  /** `drug-batch-registry` batch id: 32 bytes as 64 hex characters. */
  @Matches(/^[0-9a-fA-F]{64}$/, { message: 'batchId must be 64 hexadecimal characters' })
  batchId: string;
}
