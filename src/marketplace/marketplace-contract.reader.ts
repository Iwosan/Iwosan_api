import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as StellarSdk from '@stellar/stellar-sdk';
import { describeError } from '../common/utils/describe-error.util';

/** Decoded `Order` struct returned by the contract's `get_order`. */
export interface OnChainMarketplaceOrder {
  onChainOrderId: string;
  onChainListingId: string;
  buyerAddress: string;
  sellerAddress: string;
  units: number;
  amount: string;
}

interface RawOrder {
  id?: bigint | number | string;
  listing_id?: bigint | number | string;
  buyer?: string;
  seller?: string;
  units?: number;
  amount?: bigint | number | string;
}

/**
 * Read-only client for the `iwosan-marketplace` contract.
 *
 * The contract's `ordered` event carries only the order id and amount, so the
 * event indexer reads the order itself (`get_order`) through a Soroban
 * simulation instead of sending a transaction.
 */
@Injectable()
export class MarketplaceContractReader {
  private readonly logger = new Logger(MarketplaceContractReader.name);
  private readonly server: StellarSdk.SorobanRpc.Server | null;
  private readonly horizon: StellarSdk.Horizon.Server;
  private readonly networkPassphrase: string;
  private readonly contractId: string;
  private readonly sourcePublicKey: string;

  constructor(private readonly config: ConfigService) {
    const isMainnet = this.config.get<string>('STELLAR_NETWORK', 'testnet') === 'mainnet';
    this.server =
      this.config.get<string>('STELLAR_MARKETPLACE_EVENTS_ENABLED', 'false') === 'true'
        ? new StellarSdk.SorobanRpc.Server(
            this.config.get<string>(
              'SOROBAN_RPC_URL',
              isMainnet
                ? 'https://soroban-rpc.mainnet.stellar.gateway.fm'
                : 'https://soroban-testnet.stellar.org',
            ),
            { allowHttp: false },
          )
        : null;
    this.horizon = new StellarSdk.Horizon.Server(
      this.config.get<string>(
        'STELLAR_HORIZON_URL',
        isMainnet ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org',
      ),
      { allowHttp: false },
    );
    this.networkPassphrase = isMainnet ? StellarSdk.Networks.PUBLIC : StellarSdk.Networks.TESTNET;
    this.contractId = this.config.get<string>('STELLAR_MARKETPLACE_CONTRACT_ID', '');
    this.sourcePublicKey = this.resolveSourcePublicKey();
  }

  get isConfigured(): boolean {
    return Boolean(this.server && this.contractId && this.sourcePublicKey);
  }

  /** `null` when the contract has no order with that id. */
  async getOrder(orderId: string): Promise<OnChainMarketplaceOrder | null> {
    if (!this.server || !this.contractId || !this.sourcePublicKey) {
      throw new ServiceUnavailableException('Marketplace contract reader is not configured');
    }

    try {
      const account = await this.horizon.loadAccount(this.sourcePublicKey);
      const contract = new StellarSdk.Contract(this.contractId);
      const tx = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          contract.call('get_order', StellarSdk.nativeToScVal(BigInt(orderId), { type: 'u64' })),
        )
        .setTimeout(30)
        .build();

      const simulation = await this.server.simulateTransaction(tx);
      if (StellarSdk.SorobanRpc.Api.isSimulationError(simulation)) {
        this.logger.warn(`get_order(${orderId}) simulation failed: ${simulation.error}`);
        return null;
      }

      const retval = simulation.result?.retval;
      if (!retval) {
        return null;
      }
      return this.toOrder(StellarSdk.scValToNative(retval) as RawOrder);
    } catch (error: unknown) {
      this.logger.warn(
        `Unable to read order ${orderId} from ${this.contractId}: ${describeError(error)}`,
      );
      throw new ServiceUnavailableException(
        'Unable to read the order from the marketplace contract',
      );
    }
  }

  private toOrder(raw: RawOrder): OnChainMarketplaceOrder {
    return {
      onChainOrderId: String(raw.id ?? ''),
      // The contract stores the listing id as `listing_id`.
      onChainListingId: String(raw.listing_id ?? ''),
      buyerAddress: raw.buyer ?? '',
      sellerAddress: raw.seller ?? '',
      units: Number(raw.units ?? 0),
      amount: String(raw.amount ?? '0'),
    };
  }

  private resolveSourcePublicKey(): string {
    const explicit = this.config.get<string>('STELLAR_PUBLIC_KEY');
    if (explicit) {
      return explicit;
    }
    const secret = this.config.get<string>('STELLAR_SECRET_KEY');
    if (!secret) {
      return '';
    }
    try {
      return StellarSdk.Keypair.fromSecret(secret).publicKey();
    } catch {
      this.logger.warn('STELLAR_SECRET_KEY is not a valid Stellar secret key');
      return '';
    }
  }
}
