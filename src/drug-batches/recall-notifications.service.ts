import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Like, Repository } from 'typeorm';
import { User } from '../auth/entities/user.entity';
import { MarketplaceOrdersService } from '../marketplace/marketplace-orders.service';
import {
  NotificationOutboxEntry,
  OutboxStatus,
} from '../notifications/entities/notification-outbox.entity';
import { NotificationEventType } from '../notifications/interfaces/notification-event.interface';
import { NotificationOutboxService } from '../notifications/services/notification-outbox.service';

/** Outcome of fanning out one recall to the affected buyers. */
export interface RecallFanOut {
  batchId: string;
  affectedOrders: number;
  affectedBuyers: number;
  /** Buyers with an Iwosan account that a notification was queued for. */
  queued: number;
  /** Buyer addresses with no linked Iwosan account; they cannot be notified. */
  unreachableBuyers: string[];
}

/** How far a recall has reached, for the admin dashboard. */
export interface RecallReach {
  batchId: string;
  affectedOrders: number;
  affectedBuyers: number;
  /** Buyers whose alert was delivered. */
  notified: number;
  /** Alerts still waiting for (another) delivery attempt. */
  pending: number;
  /** Alerts that could not be delivered after every retry. */
  failed: number;
  /** Buyers with no linked Iwosan account. */
  unreachable: number;
}

/**
 * Warns buyers when a drug batch they received is recalled. Alerts go through
 * the notification outbox keyed by batch and buyer, so each buyer is notified
 * once per recall even if the recall event is processed again.
 */
@Injectable()
export class RecallNotificationsService {
  private readonly logger = new Logger(RecallNotificationsService.name);

  constructor(
    private readonly orders: MarketplaceOrdersService,
    private readonly outbox: NotificationOutboxService,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(NotificationOutboxEntry)
    private readonly outboxEntries: Repository<NotificationOutboxEntry>,
  ) {}

  async handleRecall(batchId: string, txHash?: string): Promise<RecallFanOut> {
    const id = batchId.toLowerCase();
    const orders = await this.orders.findByBatch(id);
    const buyerAddresses = [...new Set(orders.map((order) => order.buyerAddress))];
    const buyers = await this.usersByAddress(buyerAddresses);

    let queued = 0;
    const unreachableBuyers: string[] = [];
    for (const address of buyerAddresses) {
      const user = buyers.get(address);
      if (!user) {
        unreachableBuyers.push(address);
        continue;
      }
      const product = orders.find((order) => order.buyerAddress === address)?.listing?.title;
      await this.outbox.enqueue(
        this.dedupeKey(id, user.id),
        {
          eventType: NotificationEventType.DRUG_RECALL,
          actorId: 'drug-batch-registry',
          resourceId: id,
          timestamp: new Date(),
          metadata: { batchId: id, product, txHash },
        },
        user.id,
      );
      queued += 1;
    }

    this.logger.log(
      `Recall of batch ${id}: ${orders.length} orders, ${queued} buyers notified, ` +
        `${unreachableBuyers.length} without an account`,
    );
    return {
      batchId: id,
      affectedOrders: orders.length,
      affectedBuyers: buyerAddresses.length,
      queued,
      unreachableBuyers,
    };
  }

  async reach(batchId: string): Promise<RecallReach> {
    const id = batchId.toLowerCase();
    const orders = await this.orders.findByBatch(id);
    const buyerAddresses = [...new Set(orders.map((order) => order.buyerAddress))];
    const buyers = await this.usersByAddress(buyerAddresses);
    const entries = await this.outboxEntries.find({
      where: { dedupe_key: Like(`${this.dedupeKey(id, '')}%`) },
    });

    const count = (status: OutboxStatus) => entries.filter((e) => e.status === status).length;
    return {
      batchId: id,
      affectedOrders: orders.length,
      affectedBuyers: buyerAddresses.length,
      notified: count(OutboxStatus.COMPLETED),
      pending: count(OutboxStatus.PENDING) + count(OutboxStatus.PROCESSING),
      failed: count(OutboxStatus.FAILED),
      unreachable: buyerAddresses.length - buyers.size,
    };
  }

  private dedupeKey(batchId: string, userId: string): string {
    return `drug-recall:${batchId}:${userId}`;
  }

  /** Stellar keys are excluded from default selects, so load them explicitly. */
  private async usersByAddress(addresses: string[]): Promise<Map<string, User>> {
    if (addresses.length === 0) {
      return new Map();
    }
    const users = await this.users
      .createQueryBuilder('user')
      .addSelect('user.stellarPublicKey')
      .where({ stellarPublicKey: In(addresses) })
      .getMany();
    return new Map(users.map((user) => [user.stellarPublicKey, user]));
  }
}
