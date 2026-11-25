import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as StellarSdk from '@stellar/stellar-sdk';
import { describeError } from '../common/utils/describe-error.util';

/** Decoded `DrugBatch` struct returned by the contract's `get_batch`. */
export interface OnChainDrugBatch {
  batchId: string;
  manufacturer: string;
  product: string;
  kind: 'orthodox_drug' | 'native_drug';
  /** Unix timestamp (seconds). */
  expiry: number;
  regulatoryNumber: string;
  holder: string;
  recalled: boolean;
}

/** One custody handoff returned by the contract's `get_history`. */
export interface OnChainCustodyEvent {
  /** `null` for the manufacturer's initial registration. */
  from: string | null;
  to: string;
  /** Unix timestamp (seconds). */
  at: number;
}

interface RawBatch {
  manufacturer?: string;
  product?: string;
  kind?: string[] | string;
  expiry?: bigint | number | string;
  regulatory_number?: string;
  holder?: string;
  recalled?: boolean;
}

interface RawCustodyEvent {
  from?: string | null;
  to?: string;
  at?: bigint | number | string;
}

/**
 * Read-only client for the `drug-batch-registry` contract. Reads go through a
 * Soroban simulation, so no transaction is submitted and no fee is paid.
 */
@Injectable()
export class DrugBatchContractReader {
  private readonly logger = new Logger(DrugBatchContractReader.name);
  private readonly server: StellarSdk.SorobanRpc.Server;
  private readonly horizon: StellarSdk.Horizon.Server;
  private readonly networkPassphrase: string;
  private readonly contractId: string;
  private readonly sourcePublicKey: string;

  constructor(private readonly config: ConfigService) {
    const isMainnet = this.config.get<string>('STELLAR_NETWORK', 'testnet') === 'mainnet';
    this.server = new StellarSdk.SorobanRpc.Server(
      this.config.get<string>(
        'SOROBAN_RPC_URL',
        isMainnet
          ? 'https://soroban-rpc.mainnet.stellar.gateway.fm'
          : 'https://soroban-testnet.stellar.org',
      ),
      { allowHttp: false },
    );
    this.horizon = new StellarSdk.Horizon.Server(
      this.config.get<string>(
        'STELLAR_HORIZON_URL',
        isMainnet ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org',
      ),
      { allowHttp: false },
    );
    this.networkPassphrase = isMainnet ? StellarSdk.Networks.PUBLIC : StellarSdk.Networks.TESTNET;
    this.contractId = this.config.get<string>('STELLAR_DRUG_BATCH_CONTRACT_ID', '');
    this.sourcePublicKey = this.resolveSourcePublicKey();
  }

  get isConfigured(): boolean {
    return Boolean(this.contractId && this.sourcePublicKey);
  }

  /** `null` when the contract has no batch with that id. */
  async getBatch(batchId: string): Promise<OnChainDrugBatch | null> {
    const raw = await this.simulate<RawBatch>('get_batch', batchId);
    return raw ? this.toBatch(batchId, raw) : null;
  }

  /** Custody chain, oldest first. Empty when the batch is unknown. */
  async getHistory(batchId: string): Promise<OnChainCustodyEvent[]> {
    const raw = await this.simulate<RawCustodyEvent[]>('get_history', batchId);
    return (raw ?? []).map((event) => ({
      from: event.from ?? null,
      to: event.to ?? '',
      at: Number(event.at ?? 0),
    }));
  }

  /**
   * Call a read-only contract function that takes the 32-byte batch id.
   * Returns `null` when the simulation fails, e.g. `BatchNotFound`.
   */
  private async simulate<T>(method: string, batchId: string): Promise<T | null> {
    if (!this.isConfigured) {
      throw new ServiceUnavailableException('Drug batch registry reader is not configured');
    }

    try {
      const account = await this.horizon.loadAccount(this.sourcePublicKey);
      const contract = new StellarSdk.Contract(this.contractId);
      const tx = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          contract.call(method, StellarSdk.xdr.ScVal.scvBytes(Buffer.from(batchId, 'hex'))),
        )
        .setTimeout(30)
        .build();

      const simulation = await this.server.simulateTransaction(tx);
      if (StellarSdk.SorobanRpc.Api.isSimulationError(simulation)) {
        this.logger.debug(`${method}(${batchId}) simulation failed: ${simulation.error}`);
        return null;
      }

      const retval = simulation.result?.retval;
      return retval ? (StellarSdk.scValToNative(retval) as T) : null;
    } catch (error: unknown) {
      this.logger.warn(`Unable to call ${method} on ${this.contractId}: ${describeError(error)}`);
      throw new ServiceUnavailableException('Unable to read the drug batch registry');
    }
  }

  private toBatch(batchId: string, raw: RawBatch): OnChainDrugBatch {
    // Unit enum variants decode as a one-element array, e.g. ['NativeDrug'].
    const kind = Array.isArray(raw.kind) ? raw.kind[0] : raw.kind;
    return {
      batchId,
      manufacturer: raw.manufacturer ?? '',
      product: raw.product ?? '',
      kind: kind === 'NativeDrug' ? 'native_drug' : 'orthodox_drug',
      expiry: Number(raw.expiry ?? 0),
      regulatoryNumber: raw.regulatory_number ?? '',
      holder: raw.holder ?? '',
      recalled: Boolean(raw.recalled),
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
