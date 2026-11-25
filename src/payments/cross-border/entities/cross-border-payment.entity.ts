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
import { MarketplaceOrder } from '../../../marketplace/entities/marketplace-order.entity';

/** SEP-31 statuses after which the anchor will not change the transaction again. */
export const CROSS_BORDER_TERMINAL_STATUSES = [
  'completed',
  'refunded',
  'expired',
  'error',
  'no_market',
  'too_small',
  'too_large',
];

/**
 * A SEP-31 direct payment: a relative abroad pays a Nigerian pharmacy or
 * hospital for a marketplace order or a treatment campaign. The sender and
 * receiver are SEP-12 customers registered with the anchor.
 */
@Entity('cross_border_payments')
export class CrossBorderPayment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  userId: string;

  /** Marketplace order being paid, when the payment is for an order. */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  orderId: string | null;

  @ManyToOne(() => MarketplaceOrder, { nullable: true })
  @JoinColumn({ name: 'orderId' })
  order?: MarketplaceOrder;

  /** Off-chain treatment campaign reference, when the payment is for care. */
  @Column({ nullable: true })
  campaignId: string | null;

  @Column()
  senderCustomerId: string;

  @Column()
  receiverCustomerId: string;

  @Column()
  receiverAccount: string;

  @Column('decimal', { precision: 18, scale: 7 })
  amount: string;

  @Column()
  assetCode: string;

  /** Transaction id assigned by the SEP-31 anchor. */
  @Index()
  @Column({ nullable: true })
  anchorTransactionId: string;

  @Column({ default: 'pending' })
  status: string;

  @Column()
  anchorHomeDomain: string;

  @Column({ type: 'text', nullable: true })
  message: string | null;

  /** SEP-10 JWT used to talk to the anchor about this payment. Never returned. */
  @Column({ type: 'text', nullable: true, select: false })
  authToken: string | null;

  @Column({ type: 'jsonb', nullable: true })
  rawResponse: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
