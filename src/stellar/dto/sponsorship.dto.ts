import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class SponsorAccountDto {
  /** Public key of the new user account whose reserves Iwosan will sponsor. */
  @Matches(/^G[A-Z2-7]{55}$/, {
    message: 'publicKey must be a Stellar public key (G...)',
  })
  publicKey: string;

  /**
   * Optional: the transaction returned earlier by this endpoint, signed by the
   * new account. Supplying it submits the sponsorship and creates the account.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200_000)
  signedXdr?: string;
}

export class FeeBumpDto {
  /** Base64 XDR of the user's signed inner transaction. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200_000)
  xdr: string;
}
