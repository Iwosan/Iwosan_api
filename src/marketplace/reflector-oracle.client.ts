import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as StellarSdk from '@stellar/stellar-sdk';
import { describeError } from '../common/utils/describe-error.util';

/**
 * Read-only client for the Reflector price oracle (https://reflector.network).
 *
 * Reflector publishes SEP-40 price feeds on Soroban only, so prices are read by
 * simulating a `lastprice` invocation against the oracle contract. The two
 * Pulse feeds used here both quote in USD, which lets the caller compare NGN,
 * XLM and USDC without a second base conversion:
 *
 * - Foreign Exchange Rates Pulse Oracle (fiat, base USD) for NGN
 * - External CEX & DEX Pulse Oracle (tokens, base USD) for XLM
 *
 * USDC is treated as 1 USD and is never read from an oracle.
 */
const USD_STABLECOINS = new Set(['USDC', 'USDT']);

/** Fiat symbols served by the Foreign Exchange pulse feed. */
const FIAT_SYMBOLS = new Set([
  'NGN',
  'KES',
  'GHS',
  'ZAR',
  'EUR',
  'GBP',
  'USD',
  'CAD',
  'AUD',
  'INR',
  'CNY',
  'JPY',
]);

/** Mainnet Reflector Pulse contracts; testnet deployments set their own ids. */
const MAINNET_FIAT_ORACLE = 'CBKGPWGKSKZF52CFHMTRR23TBWTPMRDIYZ4O2P5VS65BMHYH4DXMCJZC';
const MAINNET_CRYPTO_ORACLE = 'CAFJZQWSED6YAWZU3GWRTOCNPPCGBN32L7QV43XX5LZLFTK6JLN34DLN';

/** Soroban encodes an enum variant as a two-element vec: [variant, value]. */
export function oracleAssetScVal(symbol: string): StellarSdk.xdr.ScVal {
  return StellarSdk.xdr.ScVal.scvVec([
    StellarSdk.xdr.ScVal.scvSymbol('Other'),
    StellarSdk.xdr.ScVal.scvSymbol(symbol.toUpperCase()),
  ]);
}

/** Convert a fixed-point oracle price (i128) to a decimal string. */
export function formatOraclePrice(price: bigint, decimals: number): string {
  const negative = price < 0n;
  const absolute = negative ? -price : price;
  const divisor = 10n ** BigInt(decimals);
  const whole = absolute / divisor;
  const fraction = (absolute % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  const value = fraction ? `${whole}.${fraction}` : `${whole}`;
  return negative ? `-${value}` : value;
}

export interface OraclePrice {
  /** Price as a decimal string in the oracle's base asset (USD). */
  price: string;
  /** Oracle record timestamp, in seconds since the epoch. */
  timestamp: number;
}

/**
 * Decode the `Option<PriceData>` returned by `lastprice`. `null` means the
 * oracle does not quote the asset (SEP-40 returns `None`).
 */
export function parsePriceData(
  retval: StellarSdk.xdr.ScVal,
  decimals: number,
): OraclePrice | null {
  const native = StellarSdk.scValToNative(retval) as
    | { price?: bigint | number | string; timestamp?: bigint | number | string }
    | null
    | undefined;

  if (!native || native.price === undefined || native.price === null) {
    return null;
  }

  const price = BigInt(native.price as bigint);
  if (price <= 0n) {
    return null;
  }

  return {
    price: formatOraclePrice(price, decimals),
    timestamp: Number(native.timestamp ?? 0),
  };
}

@Injectable()
export class ReflectorOracleClient {
  private readonly logger = new Logger(ReflectorOracleClient.name);
  private readonly server: StellarSdk.SorobanRpc.Server;
  private readonly networkPassphrase: string;
  private readonly fiatContractId: string;
  private readonly cryptoContractId: string;
  private readonly sourcePublicKey: string;
  private readonly decimals = new Map<string, number>();

  constructor(private readonly config: ConfigService) {
    const isMainnet = this.config.get<string>('STELLAR_NETWORK', 'testnet') === 'mainnet';

    this.server = new StellarSdk.SorobanRpc.Server(
      this.config.get<string>(
        'SOROBAN_RPC_URL',
        isMainnet ? 'https://soroban-rpc.mainnet.stellar.gateway.fm' : 'https://soroban-testnet.stellar.org',
      ),
      { allowHttp: false },
    );
    this.networkPassphrase = isMainnet ? StellarSdk.Networks.PUBLIC : StellarSdk.Networks.TESTNET;
    this.fiatContractId = this.config.get<string>(
      'REFLECTOR_FIAT_ORACLE_CONTRACT_ID',
      isMainnet ? MAINNET_FIAT_ORACLE : '',
    );
    this.cryptoContractId = this.config.get<string>(
      'REFLECTOR_CRYPTO_ORACLE_CONTRACT_ID',
      isMainnet ? MAINNET_CRYPTO_ORACLE : '',
    );

    // Simulations need a valid source address but never submit a transaction,
    // so a configured key is preferred and an ephemeral one works too.
    const configured = this.config.get<string>('STELLAR_PUBLIC_KEY');
    this.sourcePublicKey = configured || StellarSdk.Keypair.random().publicKey();
  }

  get isConfigured(): boolean {
    return Boolean(this.fiatContractId || this.cryptoContractId);
  }

  private contractFor(symbol: string): string {
    return FIAT_SYMBOLS.has(symbol) ? this.fiatContractId : this.cryptoContractId;
  }

  /**
   * Latest price of each symbol in USD, e.g. `{ NGN: '0.00065', XLM: '0.12' }`.
   * Throws when the oracle is not configured, unreachable, or does not quote a
   * requested asset; the caller degrades to stored prices.
   */
  async getUsdRates(symbols: string[]): Promise<Record<string, string>> {
    const rates: Record<string, string> = {};

    for (const symbol of new Set(symbols.map((entry) => entry.trim().toUpperCase()))) {
      if (USD_STABLECOINS.has(symbol)) {
        rates[symbol] = '1';
        continue;
      }

      const contractId = this.contractFor(symbol);
      if (!contractId) {
        throw new Error(`No Reflector oracle is configured for ${symbol}`);
      }

      rates[symbol] = await this.lastPrice(contractId, symbol);
    }

    return rates;
  }

  /** Call `lastprice(Asset::Other(symbol))` and return the price in base units. */
  private async lastPrice(contractId: string, symbol: string): Promise<string> {
    try {
      const decimals = await this.oracleDecimals(contractId);
      const account = new StellarSdk.Account(this.sourcePublicKey, '0');
      const contract = new StellarSdk.Contract(contractId);
      const tx = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(contract.call('lastprice', oracleAssetScVal(symbol)))
        .setTimeout(30)
        .build();

      const simulation = await this.server.simulateTransaction(tx);
      if (StellarSdk.SorobanRpc.Api.isSimulationError(simulation)) {
        throw new Error(simulation.error);
      }

      const retval = (
        simulation as StellarSdk.SorobanRpc.Api.SimulateTransactionSuccessResponse
      ).result?.retval;
      if (!retval) {
        throw new Error('The oracle returned no price data');
      }

      const price = parsePriceData(retval, decimals);
      if (!price) {
        throw new Error(`Reflector does not quote ${symbol}`);
      }
      return price.price;
    } catch (error: unknown) {
      this.logger.warn(`Reflector ${symbol} price unavailable: ${describeError(error)}`);
      throw new Error(`Reflector price for ${symbol} is unavailable`);
    }
  }

  /** `decimals()` is fixed per oracle contract; cache it for the process. */
  private async oracleDecimals(contractId: string): Promise<number> {
    const cached = this.decimals.get(contractId);
    if (cached !== undefined) {
      return cached;
    }

    const account = new StellarSdk.Account(this.sourcePublicKey, '0');
    const contract = new StellarSdk.Contract(contractId);
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call('decimals'))
      .setTimeout(30)
      .build();

    const simulation = await this.server.simulateTransaction(tx);
    if (StellarSdk.SorobanRpc.Api.isSimulationError(simulation)) {
      throw new Error(simulation.error);
    }

    const retval = (
      simulation as StellarSdk.SorobanRpc.Api.SimulateTransactionSuccessResponse
    ).result?.retval;
    const decimals = Number(retval ? StellarSdk.scValToNative(retval) : NaN);
    if (!Number.isInteger(decimals) || decimals < 0) {
      throw new Error('The oracle returned invalid decimals');
    }

    this.decimals.set(contractId, decimals);
    return decimals;
  }
}
