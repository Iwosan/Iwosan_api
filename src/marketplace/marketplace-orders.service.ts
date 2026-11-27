import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../auth/entities/user.entity';
import {
  MarketplaceOrder,
  MarketplaceOrderStatus,
  MarketplacePaymentStatus,
} from './entities/marketplace-order.entity';
import { ListingKind, MarketplaceListing } from './entities/marketplace-listing.entity';
import { OnChainMarketplaceOrder } from './marketplace-contract.reader';

export type OrderRole = 'buyer' | 'seller';

const UNIQUE_VIOLATION = '23505';

/**
 * Owns the `marketplace_orders` projection. The event stream feeds it from
 * on-chain events; the HTTP layer only reads it and records user disputes.
 */
@Injectable()
export class MarketplaceOrdersService {
  private readonly logger = new Logger(MarketplaceOrdersService.name);

  constructor(
    @InjectRepository(MarketplaceOrder)
    private readonly orders: Repository<MarketplaceOrder>,
    @InjectRepository(MarketplaceListing)
    private readonly listings: Repository<MarketplaceListing>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  /**
   * Insert the order behind an `ordered` event. Replays are ignored: the unique
   * `onChainOrderId` makes indexing idempotent.
   */
  async recordOrder(
    order: OnChainMarketplaceOrder & { txHash?: string; ledger?: number },
  ): Promise<MarketplaceOrder> {
    const onChainOrderId = order.onChainOrderId;
    const existing = await this.orders.findOne({ where: { onChainOrderId } });
    if (existing) {
      return existing;
    }

    const listing = await this.listings.findOne({
      where: { onChainListingId: order.onChainListingId },
    });

    const entity = this.orders.create({
      onChainOrderId,
      onChainListingId: order.onChainListingId,
      buyerAddress: order.buyerAddress,
      sellerAddress: order.sellerAddress,
      units: order.units,
      amount: order.amount,
      currency: listing?.currency ?? 'USDC',
      status: MarketplaceOrderStatus.ESCROWED,
      disputed: false,
      paymentStatus: MarketplacePaymentStatus.UNPAID,
      paidAt: null,
      txHash: order.txHash ?? null,
      ledger: order.ledger ?? null,
    });

    try {
      return await this.orders.save(entity);
    } catch (error: unknown) {
      // A concurrent replay may have inserted the same order first.
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        const raced = await this.orders.findOne({ where: { onChainOrderId } });
        if (raced) {
          return raced;
        }
      }
      throw error;
    }
  }

  /**
   * Apply a `settled` event. Returns the updated order, or `null` when the
   * order has not been indexed yet (the `ordered` event is always earlier).
   */
  async settleOrder(onChainOrderId: string, release: boolean): Promise<MarketplaceOrder | null> {
    const order = await this.orders.findOne({ where: { onChainOrderId } });
    if (!order) {
      this.logger.warn(`Settled event for unknown order ${onChainOrderId}; ignoring`);
      return null;
    }

    const status = release ? MarketplaceOrderStatus.RELEASED : MarketplaceOrderStatus.REFUNDED;
    if (order.status === status) {
      return order;
    }
    order.status = status;
    return this.orders.save(order);
  }

  /** A `verified` contract event: keep the local listing in sync. */
  async markListingVerified(onChainListingId: string): Promise<void> {
    const listing = await this.listings.findOne({ where: { onChainListingId } });
    if (!listing || listing.verified) {
      return;
    }
    listing.verified = true;
    await this.listings.save(listing);
  }

  /** Orders where the authenticated user is the buyer or the seller. */
  async findForUser(userId: string, role: OrderRole): Promise<MarketplaceOrder[]> {
    const address = await this.stellarAddressFor(userId);
    if (!address) {
      return [];
    }

    return this.orders.find({
      where: role === 'buyer' ? { buyerAddress: address } : { sellerAddress: address },
      relations: { listing: true },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Flag an escrowed order for the admin. Either party may open a dispute, and
   * only while the escrow is still open.
   */
  async openDispute(orderId: string, userId: string): Promise<MarketplaceOrder> {
    const order = await this.orders.findOne({
      where: { id: orderId },
      relations: { listing: true },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }

    const address = await this.stellarAddressFor(userId);
    if (!address || (address !== order.buyerAddress && address !== order.sellerAddress)) {
      throw new ForbiddenException('Only the buyer or seller can dispute this order');
    }
    if (order.status !== MarketplaceOrderStatus.ESCROWED) {
      throw new BadRequestException('Only an escrowed order can be disputed');
    }
    if (order.disputed) {
      return order;
    }

    order.disputed = true;
    order.disputedAt = new Date();
    order.disputedBy = address;
    return this.orders.save(order);
  }

  /**
   * The seller records which `drug-batch-registry` batch a drug order was
   * fulfilled from, so the buyer can be warned if that batch is recalled.
   */
  async assignBatch(orderId: string, userId: string, batchId: string): Promise<MarketplaceOrder> {
    const order = await this.orders.findOne({
      where: { id: orderId },
      relations: { listing: true },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }

    const address = await this.stellarAddressFor(userId);
    if (!address || address !== order.sellerAddress) {
      throw new ForbiddenException('Only the seller can set the batch for this order');
    }
    const kind = order.listing?.kind;
    if (kind !== ListingKind.ORTHODOX_DRUG && kind !== ListingKind.NATIVE_DRUG) {
      throw new BadRequestException('Batches can only be set on drug orders');
    }

    order.batchId = batchId.toLowerCase();
    return this.orders.save(order);
  }

  /** Orders fulfilled from a batch, for recall notifications. */
  findByBatch(batchId: string): Promise<MarketplaceOrder[]> {
    return this.orders.find({ where: { batchId: batchId.toLowerCase() } });
  }

  /** Called when a SEP-31 payment for this order completes. */
  async markPaid(orderId: string, paymentTxId?: string): Promise<MarketplaceOrder | null> {
    const order = await this.orders.findOne({ where: { id: orderId } });
    if (!order) {
      return null;
    }
    if (order.paymentStatus !== MarketplacePaymentStatus.PAID) {
      order.paymentStatus = MarketplacePaymentStatus.PAID;
      order.paidAt = new Date();
      if (paymentTxId) {
        order.txHash = paymentTxId;
      }
      return this.orders.save(order);
    }
    return order;
  }

  /** Stellar keys are excluded by default, so load the column explicitly. */
  async stellarAddressFor(userId: string): Promise<string | null> {
    const user = await this.users
      .createQueryBuilder('user')
      .addSelect('user.stellarPublicKey')
      .where('user.id = :userId', { userId })
      .getOne();

    if (!user) {
      throw new UnauthorizedException('Authenticated user not found');
    }
    return user.stellarPublicKey || null;
  }
}
