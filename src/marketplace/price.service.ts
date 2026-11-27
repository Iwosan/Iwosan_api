import { Injectable, Logger } from '@nestjs/common';
import { describeError } from '../common/utils/describe-error.util';
import { ReflectorOracleClient } from './reflector-oracle.client';

/** Oracle rates are reused for a minute, so prices refresh within 60s (#10). */
export const PRICE_CACHE_TTL_MS = 60_000;

/** Currencies the marketplace can display listing prices in. */
export const DISPLAY_CURRENCIES = ['NGN', 'USDC', 'XLM'] as const;
export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number];

export interface DisplayPrice {
  /** Listing price in `displayCurrency`, or the stored price when converted. */
  displayPrice: string;
  displayCurrency: string;
}

interface UsdRates {
  /** USD per one unit of each asset, e.g. `{ NGN: '0.00065' }`. */
  rates: Record<string, string>;
  expiresAt: number;
}

const FIAT_DISPLAY_DECIMALS = 2;
const CRYPTO_DISPLAY_DECIMALS = 7;

/** Trim trailing zeros without turning `100` into `1`. */
export function formatDisplayAmount(value: number, currency: string): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }
  const decimals = currency.toUpperCase() === 'NGN' ? FIAT_DISPLAY_DECIMALS : CRYPTO_DISPLAY_DECIMALS;
  const fixed = value.toFixed(decimals);
  if (!fixed.includes('.')) {
    return fixed;
  }
  return fixed.replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Converts listing prices into NGN, USDC or XLM using the Reflector oracle.
 *
 * Rates are cached for {@link PRICE_CACHE_TTL_MS}. If the oracle is
 * unavailable the stored `unitPrice` and its currency are returned instead, so
 * the marketplace keeps working while the price feed is down.
 */
@Injectable()
export class PriceService {
  private readonly logger = new Logger(PriceService.name);
  private cache: UsdRates | null = null;

  constructor(private readonly oracle: ReflectorOracleClient) {}

  /**
   * Add `displayPrice` and `displayCurrency` to every listing. Items that
   * cannot be converted keep their stored price.
   */
  async addDisplayPrices<T extends { unitPrice: string; currency: string }>(
    listings: T[],
    displayCurrency: string,
  ): Promise<Array<T & DisplayPrice>> {
    const target = displayCurrency.toUpperCase();
    const rates = await this.usdRates();

    return listings.map((listing) => {
      const converted = rates
        ? this.convert(listing.unitPrice, listing.currency, target, rates)
        : null;

      return {
        ...listing,
        displayPrice: converted ?? listing.unitPrice,
        displayCurrency: converted ? target : listing.currency,
      };
    });
  }

  /** USD rates for the supported display currencies, cached for 60s. */
  async usdRates(): Promise<Record<string, string> | null> {
    if (this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.rates;
    }

    try {
      const rates = await this.oracle.getUsdRates([...DISPLAY_CURRENCIES]);
      this.cache = { rates, expiresAt: Date.now() + PRICE_CACHE_TTL_MS };
      return rates;
    } catch (error: unknown) {
      this.logger.warn(`Falling back to stored listing prices: ${describeError(error)}`);
      return null;
    }
  }

  /**
   * Convert an amount between two assets through their USD rates:
   * `amount * usd(from) / usd(to)`.
   */
  private convert(
    amount: string,
    fromCurrency: string,
    toCurrency: string,
    rates: Record<string, string>,
  ): string | null {
    const from = Number(rates[fromCurrency.toUpperCase()]);
    const to = Number(rates[toCurrency.toUpperCase()]);
    const value = Number(amount);

    if (!Number.isFinite(value) || !Number.isFinite(from) || !Number.isFinite(to)) {
      return null;
    }
    if (from <= 0 || to <= 0) {
      return null;
    }

    return formatDisplayAmount((value * from) / to, toCurrency);
  }
}
