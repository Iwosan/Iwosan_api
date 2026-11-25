import { Type } from 'class-transformer';
import {
  IsEmail,
  IsNumberString,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class CrossBorderPartyDto {
  /** Stellar account of the party (the sender's or receiver's wallet). */
  @Matches(/^G[A-Z2-7]{55}$/, { message: 'account must be a Stellar public key (G...)' })
  account: string;

  /** Reuse an existing SEP-12 customer instead of registering a new one. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  customerId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  lastName?: string;

  @IsOptional()
  @IsEmail()
  email?: string;
}

export class CreateCrossBorderPaymentDto {
  /** Marketplace order funded by this payment. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  orderId?: string;

  /** Or the treatment campaign being funded. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  campaignId?: string;

  @IsNumberString()
  amount: string;

  /** Anchor asset code; defaults to ANCHOR_ASSET_CODE (USDC). */
  @IsOptional()
  @IsString()
  @MaxLength(12)
  assetCode?: string;

  @ValidateNested()
  @Type(() => CrossBorderPartyDto)
  sender: CrossBorderPartyDto;

  @ValidateNested()
  @Type(() => CrossBorderPartyDto)
  receiver: CrossBorderPartyDto;

  /** SEP-10 JWT issued by the anchor to the sending wallet. */
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  authToken?: string;
}
