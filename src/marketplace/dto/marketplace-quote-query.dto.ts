import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Matches, Min } from 'class-validator';

const ASSET_PATTERN = /^(?:XLM|native|[A-Za-z0-9]{1,12}(?::G[A-Z2-7]{55})?)$/;
const STELLAR_ACCOUNT_PATTERN = /^G[A-Z2-7]{55}$/;

export class MarketplaceQuoteQueryDto {
  @IsUUID()
  listingId: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  units: number;

  /**
   * Asset the buyer pays with: `XLM`/`native`, or `CODE:ISSUER`. A bare code
   * such as `NGN` is resolved through STELLAR_ASSET_ISSUERS.
   */
  @IsString()
  @Matches(ASSET_PATTERN, {
    message: 'sourceAsset must be XLM or CODE:ISSUER',
  })
  sourceAsset: string;

  /**
   * Buyer account used as the source of the unsigned path-payment transaction.
   * When omitted the quote is still returned, but without an XDR.
   */
  @IsOptional()
  @Matches(STELLAR_ACCOUNT_PATTERN, {
    message: 'sourceAccount must be a Stellar public key (G...)',
  })
  sourceAccount?: string;
}
