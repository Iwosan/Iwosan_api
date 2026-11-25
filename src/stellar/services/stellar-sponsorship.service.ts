import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as StellarSdk from '@stellar/stellar-sdk';
import { describeError } from '../../common/utils/describe-error.util';
import { KEY_STORE, KeyStore } from '../../key-management/interfaces/key-store.interface';
import { FixedWindowRateLimiter } from './fixed-window-rate-limiter';

/** Minimum balance needed for the new account's own reserve, in XLM. */
const MIN_ACCOUNT_BALANCE = '1.5';

export interface SponsoredAccountTransaction {
  xdr: string;
  sponsor: string;
  usdcAsset: string;
  networkPassphrase: string;
}

export interface SubmittedTransaction {
  hash: string;
  sponsor: string;
}

export interface FeeBumpResult {
  hash: string;
  feeAccount: string;
  maxFee: string;
}

/**
 * Lets new Iwosan users start without buying XLM:
 *
 * - `sponsorAccount` builds a transaction that creates the user's account and
 *   USDC trustline with reserves sponsored by Iwosan (CAP-33), and submits it
 *   once the user's wallet has signed.
 * - `submitFeeBump` wraps an already signed user transaction in a fee-bump
 *   paid for by the Iwosan fee account, so the user needs no XLM for fees.
 *
 * Both are rate limited per user; fee-account secrets come from the
 * key-management module's key store (with an env fallback for local setups).
 */
@Injectable()
export class StellarSponsorshipService {
  private readonly logger = new Logger(StellarSponsorshipService.name);
  private readonly horizon: StellarSdk.Horizon.Server;
  private readonly networkPassphrase: string;
  private readonly usdcAsset: StellarSdk.Asset;
  private readonly feeBumpBaseFee: string;
  private readonly sponsorLimiter: FixedWindowRateLimiter;
  private readonly feeBumpLimiter: FixedWindowRateLimiter;

  constructor(
    private readonly config: ConfigService,
    @Inject(KEY_STORE) private readonly keyStore: KeyStore,
  ) {
    const isMainnet = this.config.get<string>('STELLAR_NETWORK', 'testnet') === 'mainnet';
    this.networkPassphrase = isMainnet ? StellarSdk.Networks.PUBLIC : StellarSdk.Networks.TESTNET;
    this.horizon = new StellarSdk.Horizon.Server(
      this.config.get<string>(
        'STELLAR_HORIZON_URL',
        isMainnet ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org',
      ),
      { allowHttp: false },
    );

    this.usdcAsset = new StellarSdk.Asset(
      this.config.get<string>('STELLAR_USDC_CODE', 'USDC'),
      this.config.get<string>(
        'STELLAR_USDC_ISSUER',
        'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      ),
    );
    this.feeBumpBaseFee = this.config.get<string>('STELLAR_FEE_BUMP_BASE_FEE', '2000000');

    const windowMs = Number(
      this.config.get<string>('STELLAR_SPONSOR_RATE_WINDOW_MS', String(60 * 60 * 1000)),
    );
    this.sponsorLimiter = new FixedWindowRateLimiter(
      Number(this.config.get<string>('STELLAR_SPONSOR_RATE_LIMIT', '5')),
      windowMs,
    );
    this.feeBumpLimiter = new FixedWindowRateLimiter(
      Number(this.config.get<string>('STELLAR_FEE_BUMP_RATE_LIMIT', '30')),
      windowMs,
    );
  }

  /**
   * Build the sponsored-reserve transaction for a new account, or submit it
   * when `signedXdr` (signed by the new account) is supplied.
   */
  async sponsorAccount(
    userId: string,
    publicKey: string,
    signedXdr?: string,
  ): Promise<SponsoredAccountTransaction | SubmittedTransaction> {
    this.enforce(this.sponsorLimiter, userId, 'Account sponsorship');

    if (signedXdr) {
      return this.submitSigned(signedXdr);
    }

    const sponsor = await this.keypairFor('stellar:sponsor-account', 'STELLAR_SPONSOR_SECRET');
    const account = await this.horizon.loadAccount(sponsor.publicKey());

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(StellarSdk.Operation.beginSponsoringFutureReserves({ sponsoredId: publicKey }))
      .addOperation(
        StellarSdk.Operation.createAccount({
          destination: publicKey,
          startingBalance: MIN_ACCOUNT_BALANCE,
        }),
      )
      .addOperation(StellarSdk.Operation.changeTrust({ asset: this.usdcAsset, source: publicKey }))
      .addOperation(StellarSdk.Operation.endSponsoringFutureReserves({ source: publicKey }))
      .setTimeout(300)
      .build();

    // The sponsored account must also sign (ChangeTrust and
    // EndSponsoringFutureReserves are sourced by it).
    tx.sign(sponsor);

    return {
      xdr: tx.toXDR(),
      sponsor: sponsor.publicKey(),
      usdcAsset: `${this.usdcAsset.getCode()}:${this.usdcAsset.getIssuer()}`,
      networkPassphrase: this.networkPassphrase,
    };
  }

  /** Wrap a signed inner transaction in an Iwosan-paid fee bump and submit it. */
  async submitFeeBump(userId: string, xdr: string): Promise<FeeBumpResult> {
    this.enforce(this.feeBumpLimiter, userId, 'Fee-bump');

    let inner: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction;
    try {
      inner = StellarSdk.TransactionBuilder.fromXDR(xdr, this.networkPassphrase);
    } catch {
      throw new BadRequestException('xdr is not a valid Stellar transaction envelope');
    }
    if (inner instanceof StellarSdk.FeeBumpTransaction) {
      throw new BadRequestException('xdr must be an unsigned inner transaction, not a fee bump');
    }

    const feeAccount = await this.keypairFor('stellar:fee-account', 'STELLAR_FEE_ACCOUNT_SECRET');
    const feeBump = new StellarSdk.FeeBumpTransaction(
      feeAccount,
      this.feeBumpBaseFee,
      inner,
      this.networkPassphrase,
    );
    feeBump.sign(feeAccount);

    try {
      const result = await this.horizon.submitTransaction(feeBump);
      this.logger.log(`Submitted fee-bump ${result.hash} paying for ${feeAccount.publicKey()}`);
      return {
        hash: result.hash,
        feeAccount: feeAccount.publicKey(),
        maxFee: feeBump.fee,
      };
    } catch (error: unknown) {
      this.logger.warn(`Fee-bump submission failed: ${describeError(error)}`);
      throw new BadRequestException('The fee-bump transaction was rejected by the network');
    }
  }

  private async submitSigned(signedXdr: string): Promise<SubmittedTransaction> {
    let tx: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction;
    try {
      tx = StellarSdk.TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    } catch {
      throw new BadRequestException('signedXdr is not a valid Stellar transaction envelope');
    }

    try {
      const result = await this.horizon.submitTransaction(tx);
      const source = (result as { source_account?: string }).source_account ?? '';
      return { hash: result.hash, sponsor: source };
    } catch (error: unknown) {
      this.logger.warn(`Sponsored account submission failed: ${describeError(error)}`);
      throw new BadRequestException(
        'The sponsored account transaction was rejected by the network',
      );
    }
  }

  /** Fee/sponsor secrets live in the key store; env vars are a local fallback. */
  private async keypairFor(keyId: string, envVar: string): Promise<StellarSdk.Keypair> {
    let secret: string | undefined;
    try {
      secret = await this.keyStore.retrieveKey(keyId);
    } catch {
      secret = this.config.get<string>(envVar);
    }
    if (!secret) {
      throw new ServiceUnavailableException(
        `Stellar key "${keyId}" is not configured (set ${envVar} for local development)`,
      );
    }
    try {
      return StellarSdk.Keypair.fromSecret(secret);
    } catch {
      throw new ServiceUnavailableException(`Stellar key "${keyId}" is not a valid secret key`);
    }
  }

  private enforce(limiter: FixedWindowRateLimiter, userId: string, action: string): void {
    if (!limiter.consume(userId)) {
      throw new HttpException(
        `${action} limit reached for this account. Try again later.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
