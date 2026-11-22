import { IsString, Matches } from 'class-validator';

const STELLAR_ACCOUNT_PATTERN = /^G[A-Z2-7]{55}$/;

export class StellarChallengeQueryDto {
  @IsString()
  @Matches(STELLAR_ACCOUNT_PATTERN, {
    message: 'account must be a Stellar public key (G...)',
  })
  account: string;
}

export class StellarTokenDto {
  @IsString()
  @Matches(STELLAR_ACCOUNT_PATTERN, {
    message: 'account must be a Stellar public key (G...)',
  })
  account: string;

  /** Base64-encoded SEP-10 challenge envelope signed by the wallet. */
  @IsString()
  transaction: string;
}
