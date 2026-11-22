import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/** Mirrors `ListingKind` in the `iwosan-marketplace` Soroban contract. */
export enum ListingKind {
  EQUIPMENT = 'equipment',
  ORTHODOX_DRUG = 'orthodox_drug',
  NATIVE_DRUG = 'native_drug',
  PERSONNEL = 'personnel',
}

/** Mirrors `TradeMode` in the `iwosan-marketplace` Soroban contract. */
export enum TradeMode {
  SALE = 'sale',
  RENTAL = 'rental',
  HIRE = 'hire',
}

/**
 * Off-chain catalogue entry for a marketplace listing. Payment and escrow live
 * on-chain; this table holds the searchable details and the on-chain id.
 */
@Entity('marketplace_listings')
export class MarketplaceListing {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  sellerId: string;

  /** Seller's Stellar account (G...), paid out by the escrow contract. */
  @Column()
  sellerStellarAddress: string;

  @Index()
  @Column({ type: 'enum', enum: ListingKind })
  kind: ListingKind;

  @Column({ type: 'enum', enum: TradeMode })
  mode: TradeMode;

  @Column()
  title: string;

  @Column('text', { nullable: true })
  description: string;

  /** Price per item, day or shift, in the payment asset (e.g. USDC). */
  @Column('decimal', { precision: 18, scale: 7 })
  unitPrice: string;

  @Column({ default: 'USDC' })
  currency: string;

  @Column({ default: 0 })
  stock: number;

  @Column({ nullable: true })
  location: string;

  /** NAFDAC registration number for drugs, or practising licence for personnel. */
  @Column({ nullable: true })
  regulatoryNumber: string;

  /** Listing id returned by the `create_listing` contract call. */
  @Column({ type: 'bigint', nullable: true })
  onChainListingId: string;

  @Column({ default: false })
  verified: boolean;

  @Column({ default: true })
  active: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
