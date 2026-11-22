import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as StellarSdk from '@stellar/stellar-sdk';
import { describeError } from '../common/utils/describe-error.util';
import { MarketplaceService } from './marketplace.service';
import { MarketplaceQuoteQueryDto } from './dto/marketplace-quote-query.dto';

export const QUOTE_TTL_MS = 30_000;

export interface MarketplaceQuote {
  listingId: string;
  units: number;
  sourceAsset: string;
  sourceAmount: string;
  destinationAsset: string;
  destinationAmount: string;
  /** Intermediate assets in the payment path, as CODE:ISSUER (or XLM). */
  path: string[];
  /** Unsigned pathPaymentStrictReceive envelope, or null without sourceAccount. */
  xdr: string | null;
  expiresAt: string;
}

interface HorizonPathRecord {
  source_asset_type?: string;
  source_asset_code?: string;
  source_asset_issuer?: string;
  source_amount: string;
  destination_amount?: string;
  path?: Array<{
    asset_type?: string;
    asset_code?: string;
    asset_issuer?: string;
  }>;
}

const STROOPS_PER_UNIT = 10_000_000n;

/** Default issuers so a fresh testnet deployment works without extra config. */
const TESTNET_ISSUERS: Record<string, string> = {
  USDC: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
};
const MAINNET_ISSUERS: Record<string, string> = {
  USDC: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
};

@Injectable()
export class MarketplaceQuotesService {
  private readonly logger = new Logger(MarketplaceQuotesService.name);
  private readonly horizonUrl: string;
  private readonly networkPassphrase: string;
  private readonly issuers: Record<string, string>;
  private readonly cache = new Map<string, { value: MarketplaceQuote; expiresAt: number }>();

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly marketplaceService: MarketplaceService,
  ) {
    const network = this.configService.get<string>('STELLAR_NETWORK', 'testnet');
    const isMainnet = network === 'mainnet';

    this.horizonUrl = this.configService.get<string>(
      'STELLAR_HORIZON_URL',
      isMainnet ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org',
    );
    this.networkPassphrase =
      this.configService.get<string>('STELLAR_NETWORK_PASSPHRASE') ??
      (isMainnet ? StellarSdk.Networks.PUBLIC : StellarSdk.Networks.TESTNET);

    this.issuers = {
      ...(isMainnet ? MAINNET_ISSUERS : TESTNET_ISSUERS),
      ...this.parseConfiguredIssuers(this.configService.get<string>('STELLAR_ASSET_ISSUERS')),
    };
  }

  async getQuote(query: MarketplaceQuoteQueryDto): Promise<MarketplaceQuote> {
    const cacheKey = [
      query.listingId,
      query.units,
      query.sourceAsset.toUpperCase(),
      query.sourceAccount ?? '',
    ].join('|');

    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return this.clone(cached.value);
    }

    const listing = await this.marketplaceService.findOne(query.listingId);
    if (!listing.active || !listing.verified) {
      throw new NotFoundException('Listing is not available for orders');
    }

    const sourceAsset = this.resolveAsset(query.sourceAsset);
    const destinationAsset = this.resolveAsset(listing.currency);
    const destinationAmount = this.multiplyAmount(listing.unitPrice, query.units);

    const records = await this.findStrictReceivePaths({
      sourceAsset,
      destinationAsset,
      destinationAmount,
      sourceAccount: query.sourceAccount,
    });

    if (records.length === 0) {
      throw new NotFoundException('No path found for the requested payment');
    }

    const best = records.reduce((current, candidate) =>
      Number(candidate.source_amount) < Number(current.source_amount) ? candidate : current,
    );

    const quote: MarketplaceQuote = {
      listingId: listing.id,
      units: query.units,
      sourceAsset: this.formatAsset(sourceAsset),
      sourceAmount: best.source_amount,
      destinationAsset: this.formatAsset(destinationAsset),
      destinationAmount,
      path: (best.path ?? []).map((asset) => this.formatPathAsset(asset)),
      xdr: query.sourceAccount
        ? await this.buildPathPaymentXdr({
            query,
            listingSeller: listing.sellerStellarAddress,
            sourceAsset,
            destinationAsset,
            sourceAmount: best.source_amount,
            destinationAmount,
            path: best.path ?? [],
          })
        : null,
      expiresAt: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
    };

    this.cache.set(cacheKey, {
      value: quote,
      expiresAt: Date.now() + QUOTE_TTL_MS,
    });

    return this.clone(quote);
  }

  private async findStrictReceivePaths(params: {
    sourceAsset: StellarSdk.Asset;
    destinationAsset: StellarSdk.Asset;
    destinationAmount: string;
    sourceAccount?: string;
  }): Promise<HorizonPathRecord[]> {
    const requestParams: Record<string, string> = {
      destination_asset_type: this.horizonAssetType(params.destinationAsset),
      destination_amount: params.destinationAmount,
      source_assets: this.formatAsset(params.sourceAsset),
    };
    if (!params.destinationAsset.isNative()) {
      requestParams.destination_asset_code = params.destinationAsset.getCode();
      requestParams.destination_asset_issuer = params.destinationAsset.getIssuer();
    }
    if (params.sourceAccount) {
      requestParams.source_account = params.sourceAccount;
    }

    try {
      const response = await firstValueFrom(
        this.httpService.get<HorizonPathRecord[]>(`${this.horizonUrl}/paths/strict-receive`, {
          params: requestParams,
        }),
      );
      return Array.isArray(response.data) ? response.data : [];
    } catch (error: unknown) {
      this.logger.warn(`Horizon strict-receive lookup failed: ${describeError(error)}`);
      throw new BadGatewayException('Unable to fetch payment paths from Horizon');
    }
  }

  private async buildPathPaymentXdr(params: {
    query: MarketplaceQuoteQueryDto;
    listingSeller: string;
    sourceAsset: StellarSdk.Asset;
    destinationAsset: StellarSdk.Asset;
    sourceAmount: string;
    destinationAmount: string;
    path: HorizonPathRecord['path'];
  }): Promise<string> {
    const sourceAccount = params.query.sourceAccount;
    let sequence: string;

    try {
      const response = await firstValueFrom(
        this.httpService.get<{ sequence: string }>(`${this.horizonUrl}/accounts/${sourceAccount}`),
      );
      sequence = response.data.sequence;
    } catch (error: unknown) {
      this.logger.warn(`Unable to load source account ${sourceAccount}: ${describeError(error)}`);
      throw new BadRequestException(
        'sourceAccount was not found on the configured Stellar network',
      );
    }

    const transaction = new StellarSdk.TransactionBuilder(
      new StellarSdk.Account(sourceAccount, sequence),
      {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      },
    )
      .addOperation(
        StellarSdk.Operation.pathPaymentStrictReceive({
          sendAsset: params.sourceAsset,
          sendMax: params.sourceAmount,
          destination: params.listingSeller,
          destAsset: params.destinationAsset,
          destAmount: params.destinationAmount,
          path: (params.path ?? []).map((asset) => this.assetFromHorizon(asset)),
        }),
      )
      .setTimeout(300)
      .build();

    return transaction.toXDR();
  }

  private resolveAsset(spec: string): StellarSdk.Asset {
    const value = (spec ?? '').trim();
    if (/^(XLM|native)$/i.test(value)) {
      return StellarSdk.Asset.native();
    }

    const [code, configuredIssuer] = value.split(':');
    if (!/^[A-Za-z0-9]{1,12}$/.test(code ?? '')) {
      throw new BadRequestException(`Invalid asset: ${spec}`);
    }

    const issuer = configuredIssuer || this.issuers[(code ?? '').toUpperCase()];
    if (!issuer) {
      throw new BadRequestException(
        `No issuer configured for asset ${code}. Pass CODE:ISSUER or set STELLAR_ASSET_ISSUERS.`,
      );
    }

    try {
      return new StellarSdk.Asset(code, issuer);
    } catch {
      throw new BadRequestException(`Invalid asset: ${spec}`);
    }
  }

  private assetFromHorizon(asset: {
    asset_type?: string;
    asset_code?: string;
    asset_issuer?: string;
  }): StellarSdk.Asset {
    if (!asset.asset_type || asset.asset_type === 'native') {
      return StellarSdk.Asset.native();
    }
    if (!asset.asset_code || !asset.asset_issuer) {
      throw new BadGatewayException('Horizon returned an invalid path asset');
    }
    return new StellarSdk.Asset(asset.asset_code, asset.asset_issuer);
  }

  private formatAsset(asset: StellarSdk.Asset): string {
    return asset.isNative() ? 'XLM' : `${asset.getCode()}:${asset.getIssuer()}`;
  }

  private formatPathAsset(asset: {
    asset_type?: string;
    asset_code?: string;
    asset_issuer?: string;
  }): string {
    return this.formatAsset(this.assetFromHorizon(asset));
  }

  private horizonAssetType(asset: StellarSdk.Asset): string {
    if (asset.isNative()) {
      return 'native';
    }
    return asset.getCode().length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12';
  }

  /** Convert a decimal string (up to 7 dp) to stroops and multiply by units. */
  private multiplyAmount(unitPrice: string, units: number): string {
    const [whole, fraction = ''] = String(unitPrice).split('.');
    const unitStroops =
      BigInt(whole) * STROOPS_PER_UNIT + BigInt((fraction + '0000000').slice(0, 7));
    const total = unitStroops * BigInt(units);

    const wholePart = total / STROOPS_PER_UNIT;
    const fractionPart = (total % STROOPS_PER_UNIT).toString().padStart(7, '0');
    return `${wholePart}.${fractionPart}`;
  }

  private parseConfiguredIssuers(raw?: string): Record<string, string> {
    if (!raw) {
      return {};
    }

    return raw.split(',').reduce<Record<string, string>>((accumulator, entry) => {
      const [code, issuer] = entry.trim().split(':');
      if (code && issuer) {
        accumulator[code.toUpperCase()] = issuer;
      }
      return accumulator;
    }, {});
  }

  private clone(quote: MarketplaceQuote): MarketplaceQuote {
    return { ...quote, path: [...quote.path] };
  }
}
