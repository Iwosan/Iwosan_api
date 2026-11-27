jest.unmock('@stellar/stellar-sdk');

import { ConfigService } from '@nestjs/config';
import {
  PRICE_CACHE_TTL_MS,
  PriceService,
  formatDisplayAmount,
} from './price.service';
import {
  ReflectorOracleClient,
  formatOraclePrice,
  oracleAssetScVal,
  parsePriceData,
} from './reflector-oracle.client';
import * as StellarSdk from '@stellar/stellar-sdk';

const USDC_RATES = {
  USDC: '1',
  NGN: '0.0008',
  XLM: '0.125',
};

function listing(overrides: Partial<{ unitPrice: string; currency: string; title: string }> = {}) {
  return {
    id: 'listing-1',
    title: 'Wheelchair',
    unitPrice: '12.5',
    currency: 'USDC',
    ...overrides,
  };
}

describe('PriceService', () => {
  let service: PriceService;
  let oracle: { getUsdRates: jest.Mock };

  beforeEach(() => {
    oracle = { getUsdRates: jest.fn().mockResolvedValue(USDC_RATES) };
    service = new PriceService(oracle as unknown as ReflectorOracleClient);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('shows a USDC listing price in naira', async () => {
    const [priced] = await service.addDisplayPrices([listing()], 'NGN');

    // 12.5 USDC * 1 USD / 0.0008 USD per NGN = 15,625 NGN
    expect(priced.displayPrice).toBe('15625');
    expect(priced.displayCurrency).toBe('NGN');
    expect(priced.unitPrice).toBe('12.5');
  });

  it('shows a USDC listing price in XLM', async () => {
    const [priced] = await service.addDisplayPrices([listing()], 'XLM');

    // 12.5 / 0.125 = 100 XLM
    expect(priced.displayPrice).toBe('100');
    expect(priced.displayCurrency).toBe('XLM');
  });

  it('accepts a lowercase currency', async () => {
    const [priced] = await service.addDisplayPrices([listing()], 'ngn');

    expect(priced.displayCurrency).toBe('NGN');
    expect(priced.displayPrice).toBe('15625');
  });

  it('converts a listing that is not priced in USDC', async () => {
    const [priced] = await service.addDisplayPrices(
      [listing({ unitPrice: '1000', currency: 'NGN' })],
      'XLM',
    );

    // 1000 NGN * 0.0008 = 0.8 USD / 0.125 = 6.4 XLM
    expect(priced.displayPrice).toBe('6.4');
    expect(priced.displayCurrency).toBe('XLM');
  });

  it('reads the oracle once and caches the rates for 60s', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    await service.addDisplayPrices([listing()], 'NGN');
    await service.addDisplayPrices([listing()], 'XLM');
    expect(oracle.getUsdRates).toHaveBeenCalledTimes(1);

    now += PRICE_CACHE_TTL_MS - 1;
    await service.usdRates();
    expect(oracle.getUsdRates).toHaveBeenCalledTimes(1);

    now += 1;
    await service.usdRates();
    expect(oracle.getUsdRates).toHaveBeenCalledTimes(2);
  });

  it('falls back to the stored price and currency when the oracle is unavailable', async () => {
    oracle.getUsdRates.mockRejectedValue(new Error('oracle down'));

    const [priced] = await service.addDisplayPrices([listing()], 'NGN');

    expect(priced.displayPrice).toBe('12.5');
    expect(priced.displayCurrency).toBe('USDC');
  });

  it('falls back when the oracle does not quote the target currency', async () => {
    oracle.getUsdRates.mockResolvedValue({ USDC: '1', XLM: '0.125' });

    const [priced] = await service.addDisplayPrices([listing()], 'NGN');

    expect(priced.displayPrice).toBe('12.5');
    expect(priced.displayCurrency).toBe('USDC');
  });

  it('retries the oracle after a failure instead of caching the fallback', async () => {
    oracle.getUsdRates.mockRejectedValueOnce(new Error('oracle down'));

    await service.addDisplayPrices([listing()], 'NGN');
    const [priced] = await service.addDisplayPrices([listing()], 'NGN');

    expect(oracle.getUsdRates).toHaveBeenCalledTimes(2);
    expect(priced.displayPrice).toBe('15625');
  });

  it('does not request a rate for a zero price', async () => {
    const [priced] = await service.addDisplayPrices(
      [listing({ unitPrice: '0' })],
      'NGN',
    );

    expect(priced.displayPrice).toBe('0');
  });
});

describe('formatDisplayAmount', () => {
  it('trims trailing zeros without dropping integer digits', () => {
    expect(formatDisplayAmount(100, 'XLM')).toBe('100');
    expect(formatDisplayAmount(1.5, 'XLM')).toBe('1.5');
    expect(formatDisplayAmount(15625, 'NGN')).toBe('15625');
    expect(formatDisplayAmount(15625.5, 'NGN')).toBe('15625.5');
    expect(formatDisplayAmount(0.123456789, 'XLM')).toBe('0.1234568');
  });

  it('returns 0 for invalid amounts', () => {
    expect(formatDisplayAmount(Number.NaN, 'NGN')).toBe('0');
    expect(formatDisplayAmount(-3, 'NGN')).toBe('0');
  });
});

describe('Reflector oracle decoding', () => {
  it('encodes Asset::Other(symbol) as a two-element enum vec', () => {
    const scVal = oracleAssetScVal('ngn');

    expect(StellarSdk.scValToNative(scVal)).toEqual(['Other', 'NGN']);
  });

  it('formats a fixed-point oracle price', () => {
    expect(formatOraclePrice(12879967050722n, 14)).toBe('0.12879967050722');
    expect(formatOraclePrice(1n * 10n ** 14n, 14)).toBe('1');
    expect(formatOraclePrice(0n, 14)).toBe('0');
  });

  it('decodes a PriceData record', () => {
    const retval = StellarSdk.nativeToScVal({
      price: 12879967050722n,
      timestamp: 1_700_000_000,
    });

    expect(parsePriceData(retval, 14)).toEqual({
      price: '0.12879967050722',
      timestamp: 1_700_000_000,
    });
  });

  it('returns null for None and non-positive prices', () => {
    expect(parsePriceData(StellarSdk.xdr.ScVal.scvVoid(), 14)).toBeNull();
    const zero = StellarSdk.nativeToScVal({ price: 0n, timestamp: 1 });
    expect(parsePriceData(zero, 14)).toBeNull();
  });
});

describe('ReflectorOracleClient', () => {
  it('is unconfigured on testnet without explicit contract ids', () => {
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === 'STELLAR_NETWORK') return 'testnet';
        return fallback;
      }),
    } as unknown as ConfigService;

    const client = new ReflectorOracleClient(config);

    expect(client.isConfigured).toBe(false);
  });

  it('uses the mainnet Pulse contracts by default', () => {
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === 'STELLAR_NETWORK') return 'mainnet';
        return fallback;
      }),
    } as unknown as ConfigService;

    const client = new ReflectorOracleClient(config);

    expect(client.isConfigured).toBe(true);
  });
});
