jest.unmock('@stellar/stellar-sdk');

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import * as StellarSdk from '@stellar/stellar-sdk';
import { MarketplaceQuotesService } from './marketplace-quotes.service';
import { MarketplaceService } from './marketplace.service';
import { MarketplaceListing } from './entities/marketplace-listing.entity';

const USDC_ISSUER = StellarSdk.Keypair.random().publicKey();
const NGN_ISSUER = StellarSdk.Keypair.random().publicKey();
const SELLER = StellarSdk.Keypair.random().publicKey();
const BUYER = StellarSdk.Keypair.random().publicKey();

describe('MarketplaceQuotesService', () => {
  let service: MarketplaceQuotesService;
  let httpService: { get: jest.Mock };
  let marketplaceService: { findOne: jest.Mock };
  let listing: MarketplaceListing;

  const pathRecord = {
    source_asset_type: 'credit_alphanum4',
    source_asset_code: 'NGN',
    source_asset_issuer: NGN_ISSUER,
    source_amount: '25000.0000000',
    destination_amount: '25.0000000',
    path: [],
  };

  beforeEach(async () => {
    listing = {
      id: '11111111-1111-4111-8111-111111111111',
      sellerId: 'seller-1',
      sellerStellarAddress: SELLER,
      kind: 'orthodox_drug',
      mode: 'sale',
      title: 'Artemether',
      description: null,
      unitPrice: '12.5000000',
      currency: 'USDC',
      stock: 10,
      location: 'Lagos',
      regulatoryNumber: null,
      onChainListingId: null,
      verified: true,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as MarketplaceListing;

    httpService = {
      get: jest.fn((url: string) => {
        if (url.endsWith('/paths/strict-receive')) {
          return of({ data: [pathRecord] });
        }
        if (url.includes('/accounts/')) {
          return of({ data: { sequence: '42' } });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }),
    };
    marketplaceService = { findOne: jest.fn().mockResolvedValue(listing) };

    const config: Record<string, string> = {
      STELLAR_NETWORK: 'testnet',
      STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
      STELLAR_NETWORK_PASSPHRASE: StellarSdk.Networks.TESTNET,
      STELLAR_ASSET_ISSUERS: `NGN:${NGN_ISSUER},USDC:${USDC_ISSUER}`,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MarketplaceQuotesService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) => config[key] ?? defaultValue),
          },
        },
        { provide: HttpService, useValue: httpService },
        { provide: MarketplaceService, useValue: marketplaceService },
      ],
    }).compile();

    service = module.get(MarketplaceQuotesService);
  });

  it('returns the best strict-receive path and an unsigned payment XDR', async () => {
    const quote = await service.getQuote({
      listingId: listing.id,
      units: 2,
      sourceAsset: 'NGN',
      sourceAccount: BUYER,
    });

    expect(quote).toMatchObject({
      listingId: listing.id,
      units: 2,
      sourceAsset: `NGN:${NGN_ISSUER}`,
      sourceAmount: '25000.0000000',
      destinationAsset: `USDC:${USDC_ISSUER}`,
      destinationAmount: '25.0000000',
      path: [],
    });

    const [, options] = httpService.get.mock.calls[0] as [
      string,
      { params: Record<string, string> },
    ];
    expect(options.params).toMatchObject({
      destination_asset_type: 'credit_alphanum4',
      destination_asset_code: 'USDC',
      destination_asset_issuer: USDC_ISSUER,
      destination_amount: '25.0000000',
      source_assets: `NGN:${NGN_ISSUER}`,
      source_account: BUYER,
    });

    const transaction = StellarSdk.TransactionBuilder.fromXDR(
      quote.xdr,
      StellarSdk.Networks.TESTNET,
    ) as StellarSdk.Transaction;

    expect(transaction.signatures).toHaveLength(0);
    expect(transaction.source).toBe(BUYER);
    expect(transaction.operations[0]).toMatchObject({
      type: 'pathPaymentStrictReceive',
      destination: SELLER,
      sendMax: '25000.0000000',
      destAmount: '25.0000000',
    });
  });

  it('omits the XDR when no source account is supplied', async () => {
    const quote = await service.getQuote({
      listingId: listing.id,
      units: 1,
      sourceAsset: 'XLM',
    });

    expect(quote.xdr).toBeNull();
    expect(quote.sourceAsset).toBe('XLM');
    expect(quote.destinationAmount).toBe('12.5000000');
  });

  it('caches quotes for 30 seconds', async () => {
    const query = {
      listingId: listing.id,
      units: 2,
      sourceAsset: 'NGN',
      sourceAccount: BUYER,
    };

    const first = await service.getQuote(query);
    const second = await service.getQuote(query);

    expect(second).toEqual(first);
    expect(httpService.get).toHaveBeenCalledTimes(2); // paths + account
    expect(new Date(first.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('returns 404 when Horizon has no path', async () => {
    httpService.get.mockReturnValueOnce(of({ data: [] }));

    await expect(
      service.getQuote({
        listingId: listing.id,
        units: 1,
        sourceAsset: 'NGN',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects unverified listings', async () => {
    marketplaceService.findOne.mockResolvedValue({
      ...listing,
      verified: false,
    });

    await expect(
      service.getQuote({
        listingId: listing.id,
        units: 1,
        sourceAsset: 'XLM',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects an asset whose issuer is unknown', async () => {
    marketplaceService.findOne.mockResolvedValue({
      ...listing,
      currency: 'EUR',
    });

    await expect(
      service.getQuote({
        listingId: listing.id,
        units: 1,
        sourceAsset: 'XLM',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('translates Horizon failures into a bad gateway error', async () => {
    httpService.get.mockReturnValueOnce(throwError(() => new Error('horizon down')));

    await expect(
      service.getQuote({
        listingId: listing.id,
        units: 1,
        sourceAsset: 'NGN',
      }),
    ).rejects.toThrow(/Horizon/);
  });
});
