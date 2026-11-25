import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Matches } from 'class-validator';

/** A batch id is the contract's `BytesN<32>`, written as 64 hex characters. */
export const BATCH_ID_PATTERN = /^[0-9a-fA-F]{64}$/;

export class BatchIdParamDto {
  @ApiProperty({ description: 'Batch id: 32 bytes as 64 hex characters' })
  @Matches(BATCH_ID_PATTERN, { message: 'batchId must be 64 hexadecimal characters' })
  batchId: string;
}

export type BatchStatus = 'valid' | 'expired' | 'recalled';

export class CustodyStepDto {
  @ApiPropertyOptional({
    nullable: true,
    description: 'Previous holder; null for the registration',
  })
  from: string | null;

  @ApiProperty()
  to: string;

  @ApiProperty()
  at: string;
}

export class DrugBatchVerificationDto {
  @ApiProperty()
  batchId: string;

  @ApiProperty()
  product: string;

  @ApiProperty({ enum: ['orthodox_drug', 'native_drug'] })
  kind: 'orthodox_drug' | 'native_drug';

  @ApiProperty({ description: 'NAFDAC (or equivalent) registration number' })
  regulatoryNumber: string;

  @ApiProperty()
  manufacturer: string;

  @ApiProperty({ description: 'Current custodian of the batch' })
  holder: string;

  @ApiProperty()
  expiresAt: string;

  @ApiProperty()
  expired: boolean;

  @ApiProperty()
  recalled: boolean;

  @ApiProperty({
    enum: ['valid', 'expired', 'recalled'],
    description: '`recalled` takes priority over `expired`',
  })
  status: BatchStatus;

  @ApiProperty({ type: [CustodyStepDto] })
  history: CustodyStepDto[];

  @ApiProperty({ description: 'Web page the QR code points to' })
  verifyUrl: string;
}
