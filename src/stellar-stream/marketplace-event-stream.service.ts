import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as StellarSdk from '@stellar/stellar-sdk';
import Redis from 'ioredis';
import { describeError } from '../common/utils/describe-error.util';
import { MarketplaceContractReader } from '../marketplace/marketplace-contract.reader';
import { MarketplaceOrdersService } from '../marketplace/marketplace-orders.service';

const CURSOR_KEY = 'stellar:marketplace:events:cursor';
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_PAGE_SIZE = 100;

type DecodedValue = string | number | boolean | bigint | null;

/**
 * Subscribes to the `iwosan-marketplace` contract's `listed`, `verified`,
 * `ordered` and `settled` events and feeds them into the orders projection.
 *
 * Soroban events are not available from Horizon transactions, so this stream
 * polls Soroban RPC `getEvents` and stores its cursor in Redis. Replays are
 * safe: orders are keyed by their on-chain id.
 */
@Injectable()
export class MarketplaceEventStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketplaceEventStreamService.name);
  private readonly enabled: boolean;
  private readonly contractId: string;
  private readonly pollIntervalMs: number;
  private readonly startLedger: number;
  private readonly server: StellarSdk.SorobanRpc.Server | null;
  private readonly redis: Redis | null;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly config: ConfigService,
    private readonly orders: MarketplaceOrdersService,
    private readonly reader: MarketplaceContractReader,
  ) {
    this.enabled =
      this.config.get<string>('STELLAR_MARKETPLACE_EVENTS_ENABLED', 'false') === 'true';
    this.contractId = this.config.get<string>('STELLAR_MARKETPLACE_CONTRACT_ID', '');
    this.pollIntervalMs = Number(
      this.config.get<string>(
        'MARKETPLACE_EVENT_POLL_INTERVAL_MS',
        String(DEFAULT_POLL_INTERVAL_MS),
      ),
    );
    this.startLedger = Number(this.config.get<string>('MARKETPLACE_EVENT_START_LEDGER', '0'));
    const isMainnet = this.config.get<string>('STELLAR_NETWORK', 'testnet') === 'mainnet';
    this.server = this.enabled
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
    this.redis = this.enabled
      ? new Redis({
          host: this.config.get('REDIS_HOST', 'localhost'),
          port: this.config.get<number>('REDIS_PORT', 6379),
          password: this.config.get('REDIS_PASSWORD'),
          lazyConnect: true,
        })
      : null;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Marketplace event stream disabled (STELLAR_MARKETPLACE_EVENTS_ENABLED)');
      return;
    }
    this.redis?.connect().catch(() => {
      this.logger.warn('Redis unavailable — marketplace event cursor will not be persisted');
    });
    this.timer = setInterval(() => {
      void this.pollOnce().catch((error: unknown) => {
        this.logger.error(`Marketplace event poll failed: ${this.describe(error)}`);
      });
    }, this.pollIntervalMs);
    this.logger.log(`Marketplace event stream polling every ${this.pollIntervalMs}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.redis?.disconnect();
  }

  /** Fetch one page of events and apply them. Returns how many were handled. */
  async pollOnce(): Promise<number> {
    if (!this.server || !this.contractId || this.polling) {
      return 0;
    }

    this.polling = true;
    try {
      const cursor = await this.getCursor();
      if (!cursor && this.startLedger <= 0) {
        this.logger.warn(
          'MARKETPLACE_EVENT_START_LEDGER is not set and no cursor exists; skipping this poll',
        );
        return 0;
      }

      const response = await this.server.getEvents({
        ...(cursor ? { cursor } : { startLedger: this.startLedger }),
        filters: [{ type: 'contract', contractIds: [this.contractId] }],
        limit: DEFAULT_PAGE_SIZE,
      });

      let processed = 0;
      for (const event of response.events) {
        await this.handleEvent(event);
        processed += 1;
      }
      const nextCursor = (response as { cursor?: string }).cursor;
      if (nextCursor) {
        await this.saveCursor(nextCursor);
      }
      return processed;
    } finally {
      this.polling = false;
    }
  }

  /** Decode and apply one contract event. */
  async handleEvent(event: StellarSdk.SorobanRpc.Api.EventResponse): Promise<void> {
    const action = this.decode(event.topic[0]);
    const id = event.topic[1] ? String(this.decode(event.topic[1])) : undefined;

    switch (action) {
      case 'ordered': {
        if (!id) {
          return;
        }
        const order = await this.reader.getOrder(id);
        if (!order) {
          this.logger.warn(`Order ${id} was not found on-chain; skipping event ${event.id}`);
          return;
        }
        await this.orders.recordOrder({
          ...order,
          txHash: event.txHash,
          ledger: event.ledger,
        });
        break;
      }
      case 'settled': {
        if (!id) {
          return;
        }
        await this.orders.settleOrder(id, Boolean(this.decode(event.value)));
        break;
      }
      case 'verified': {
        if (id) {
          await this.orders.markListingVerified(id);
        }
        break;
      }
      case 'listed':
        // `listed` carries only the seller address; the catalogue is created
        // through the API, which stores the on-chain listing id itself.
        this.logger.debug(`Ignoring listed event for listing ${id}`);
        break;
      default:
        this.logger.debug(`Ignoring marketplace event with topic ${String(action)}`);
    }
  }

  /** Soroban scalar values decode to plain JS primitives. */
  private decode(value: StellarSdk.xdr.ScVal | undefined): DecodedValue {
    return value ? (StellarSdk.scValToNative(value) as DecodedValue) : null;
  }

  private async getCursor(): Promise<string | null> {
    try {
      return this.redis ? await this.redis.get(CURSOR_KEY) : null;
    } catch {
      return null;
    }
  }

  private async saveCursor(cursor: string): Promise<void> {
    try {
      await this.redis?.set(CURSOR_KEY, cursor);
    } catch {
      this.logger.warn('Unable to persist the marketplace event cursor');
    }
  }

  private describe(error: unknown): string {
    return describeError(error);
  }
}
