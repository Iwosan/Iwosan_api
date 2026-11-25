import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { MarketplaceListing } from './marketplace-listing.entity';

/** Mirrors `OrderStatus` in the `iwosan-marketplace` Soroban contract. */
export enum MarketplaceOrderStatus {
  ESCROWED = 'escrowed',
  RELEASED = 'released',
  REFUNDED = 'refunded',
}

/** Whether money for the order has been settled from outside the escrow, e.g. by a SEP-31 payment. */
export enum MarketplacePaymentStatus {
  UNPAID = 'unpaid',
  PAID = 'paid',
}

/**
 * On-chain escrow order indexed from the `ordered` and `settled` events of the
 * `iwosan-marketplace` contract. One row per on-chain order, so replaying the
 * event stream is idempotent.
 */
@Entity('marketplace_orders')
export class MarketplaceOrder {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Order id assigned by the contract (`place_order` return value). */
  @Index({ unique: true })
  @Column({ type: 'bigint' })
  onChainOrderId: string;

  /** Listing id assigned by the contract (`create_listing` return value). */
  @Index()
  @Column({ type: 'bigint', nullable: true })
  onChainListingId: string;

  @ManyToOne(() => MarketplaceListing, { nullable: true })
  @JoinColumn({ name: 'onChainListingId', referencedColumnName: 'onChainListingId' })
  listing?: MarketplaceListing;

  @Index()
  @Column()
  buyerAddress: string;

  @Index()
  @Column()
  sellerAddress: string;

  @Column({ type: 'int' })
  units: number;

  @Column('decimal', { precision: 18, scale: 7 })
  amount: string;

  @Column({ default: 'USDC' })
  currency: string;

  @Column({ type: 'varchar', default: MarketplaceOrderStatus.ESCROWED })
  status: MarketplaceOrderStatus;

  /** Set when the buyer or seller opens a dispute for the admin to resolve. */
  @Column({ default: false })
  disputed: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  disputedAt: Date | null;

  @Column({ nullable: true })
  disputedBy: string;

  /** Payment status for orders funded by a SEP-31 cross-border payment. */
  @Column({ type: 'varchar', default: MarketplacePaymentStatus.UNPAID })
  paymentStatus: MarketplacePaymentStatus;

  @Column({ type: 'timestamptz', nullable: true })
  paidAt: Date | null;

  /**
   * `drug-batch-registry` batch the seller dispatched for a drug order (64 hex
   * characters). Used to notify buyers when that batch is recalled.
   */
  @Index()
  @Column({ type: 'varchar', length: 64, nullable: true })
  batchId: string | null;

  @Column({ nullable: true })
  txHash: string;

  @Column({ type: 'int', nullable: true })
  ledger: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
