import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * A buyer's rating of a listing. One review per order: a review is only
 * accepted for an order that was released, and the unique `orderId` makes
 * faking extra ratings for the same purchase impossible.
 */
@Entity('marketplace_reviews')
@Unique('UQ_marketplace_reviews_orderId', ['orderId'])
export class MarketplaceReview {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  listingId: string;

  /** `marketplace_orders.id` the review was earned with (unique). */
  @Column('uuid')
  orderId: string;

  @Index()
  @Column()
  reviewerId: string;

  /** Buyer's Stellar account that placed the reviewed order. */
  @Column()
  reviewerAddress: string;

  /** 1–5 stars. */
  @Column({ type: 'int' })
  rating: number;

  @Column('text', { nullable: true })
  comment: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
