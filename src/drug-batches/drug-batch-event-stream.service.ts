import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as StellarSdk from '@stellar/stellar-sdk';
import Redis from 'ioredis';
import { describeError } from '../common/utils/describe-error.util';
import { DrugBatchesService } from './drug-batches.service';
import { RecallNotificationsService } from './recall-notifications.service';

const CURSOR_KEY = 'stellar:drug-batches:events:cursor';
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_PAGE_SIZE = 100;

/**
 * Watches the `drug-batch-registry` contract for `recalled` events and warns
 * the buyers of the recalled batch.
 *
 * Soroban events are not available from Horizon, so this polls Soroban RPC
 * `getEvents` and keeps its cursor in Redis. Replays are safe: alerts are
 * de-duplicated per batch and buyer by the notification outbox.
 */
@Injectable()
export class DrugBatchEventStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DrugBatchEventStreamService.name);
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
    private readonly batches: DrugBatchesService,
    private readonly recalls: RecallNotificationsService,
  ) {
    this.enabled = this.config.get<string>('STELLAR_DRUG_BATCH_EVENTS_ENABLED', 'false') === 'true';
    this.contractId = this.config.get<string>('STELLAR_DRUG_BATCH_CONTRACT_ID', '');
    this.pollIntervalMs = Number(
      this.config.get<string>(
        'DRUG_BATCH_EVENT_POLL_INTERVAL_MS',
        String(DEFAULT_POLL_INTERVAL_MS),
      ),
    );
    this.startLedger = Number(this.config.get<string>('DRUG_BATCH_EVENT_START_LEDGER', '0'));
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
      this.logger.log('Drug batch event stream disabled (STELLAR_DRUG_BATCH_EVENTS_ENABLED)');
      return;
    }
    this.redis?.connect().catch(() => {
      this.logger.warn('Redis unavailable — drug batch event cursor will not be persisted');
    });
    this.timer = setInterval(() => {
      void this.pollOnce().catch((error: unknown) => {
        this.logger.error(`Drug batch event poll failed: ${describeError(error)}`);
      });
    }, this.pollIntervalMs);
    this.logger.log(`Drug batch event stream polling every ${this.pollIntervalMs}ms`);
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
          'DRUG_BATCH_EVENT_START_LEDGER is not set and no cursor exists; skipping this poll',
        );
        return 0;
      }

      const response = await this.server.getEvents({
        ...(cursor ? { cursor } : { startLedger: this.startLedger }),
        filters: [{ type: 'contract', contractIds: [this.contractId] }],
        limit: DEFAULT_PAGE_SIZE,
      });

      for (const event of response.events) {
        await this.handleEvent(event);
      }
      const nextCursor = (response as { cursor?: string }).cursor;
      if (nextCursor) {
        await this.saveCursor(nextCursor);
      }
      return response.events.length;
    } finally {
      this.polling = false;
    }
  }

  /** Act on `recalled` events; other registry events are ignored. */
  async handleEvent(event: StellarSdk.SorobanRpc.Api.EventResponse): Promise<void> {
    const action = event.topic[0] ? (StellarSdk.scValToNative(event.topic[0]) as unknown) : null;
    if (action !== 'recalled') {
      return;
    }

    // The batch id is a `BytesN<32>` topic, which decodes to a Buffer.
    const rawId = event.topic[1] ? (StellarSdk.scValToNative(event.topic[1]) as unknown) : null;
    if (!Buffer.isBuffer(rawId)) {
      this.logger.warn(`Recall event ${event.id} has no batch id; skipping`);
      return;
    }

    const batchId = rawId.toString('hex');
    this.batches.forget(batchId);
    await this.recalls.handleRecall(batchId, event.txHash);
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
      this.logger.warn('Unable to persist the drug batch event cursor');
    }
  }
}
