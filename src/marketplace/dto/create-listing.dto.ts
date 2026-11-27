import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { ListingKind, TradeMode } from '../entities/marketplace-listing.entity';

export class CreateListingDto {
  @IsEnum(ListingKind)
  kind: ListingKind;

  @IsEnum(TradeMode)
  mode: TradeMode;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsNumberString()
  unitPrice: string;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  stock?: number;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  regulatoryNumber?: string;

  @Matches(/^G[A-Z2-7]{55}$/, { message: 'sellerStellarAddress must be a Stellar public key' })
  sellerStellarAddress: string;
}

export class ListListingsQueryDto {
  @IsOptional()
  @IsEnum(ListingKind)
  kind?: ListingKind;

  @IsOptional()
  @IsEnum(TradeMode)
  mode?: TradeMode;

  @IsOptional()
  @IsString()
  search?: string;

  /**
   * Display the prices in this currency (NGN, USDC or XLM) using the Reflector
   * oracle. Without it the stored `unitPrice` and `currency` are returned.
   */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsIn(['NGN', 'USDC', 'XLM'])
  currency?: string;
}
