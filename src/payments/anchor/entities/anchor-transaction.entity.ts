import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum AnchorDirection {
  DEPOSIT = 'deposit',
  WITHDRAW = 'withdraw',
}

/**
 * A SEP-24 interactive deposit or withdrawal started for an Iwosan user.
 * Status values follow SEP-24 (`incomplete`, `pending_user_transfer_start`,
 * `completed`, ...) and are refreshed from the anchor until terminal.
 */
@Entity('anchor_transactions')
export class AnchorTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  userId: string;

  @Column({ type: 'varchar' })
  direction: AnchorDirection;

  /** Stellar account that funds are deposited to or withdrawn from. */
  @Column()
  account: string;

  @Column()
  assetCode: string;

  @Column('decimal', { precision: 18, scale: 7, nullable: true })
  amount: string;

  /** Transaction id assigned by the anchor (SEP-24 `id`). */
  @Index()
  @Column({ nullable: true })
  anchorTransactionId: string;

  @Column({ type: 'text', nullable: true })
  interactiveUrl: string;

  @Column({ default: 'incomplete' })
  status: string;

  @Column()
  anchorHomeDomain: string;

  @Column({ type: 'text', nullable: true })
  message: string;

  /**
   * SEP-10 JWT issued by the anchor to the user's wallet, used only to poll
   * this transaction's status. Never returned from the API.
   */
  @Column({ type: 'text', nullable: true })
  authToken: string;

  @Column({ type: 'jsonb', nullable: true })
  rawResponse: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
