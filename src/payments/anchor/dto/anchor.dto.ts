import { IsNumberString, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class AnchorInteractionDto {
  /** Stellar account that will receive (deposit) or send (withdraw) funds. */
  @Matches(/^G[A-Z2-7]{55}$/, {
    message: 'account must be a Stellar public key (G...)',
  })
  account: string;

  /** Anchor asset code; defaults to ANCHOR_ASSET_CODE (USDC). */
  @IsOptional()
  @IsString()
  @MaxLength(12)
  assetCode?: string;

  /** Optional amount for anchors that pre-fill the interactive form. */
  @IsOptional()
  @IsNumberString()
  amount?: string;

  /**
   * SEP-10 JWT issued by the anchor to the user's wallet. Required by anchors
   * that authenticate SEP-24 requests (including testanchor.stellar.org).
   */
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  authToken?: string;
}
