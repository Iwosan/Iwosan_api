import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Create anchor_transactions
 *
 * Persists SEP-24 interactive deposit/withdraw flows started through the
 * configured anchor, including the status polled back from the anchor.
 */
export class CreateAnchorTransactions1796000000000 implements MigrationInterface {
  name = 'CreateAnchorTransactions1796000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE anchor_transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" varchar NOT NULL,
        direction varchar NOT NULL,
        account varchar NOT NULL,
        "assetCode" varchar NOT NULL,
        amount decimal(18,7),
        "anchorTransactionId" varchar,
        "interactiveUrl" text,
        status varchar NOT NULL DEFAULT 'incomplete',
        "anchorHomeDomain" varchar NOT NULL,
        message text,
        "authToken" text,
        "rawResponse" jsonb,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_anchor_transactions_userId" ON anchor_transactions ("userId");`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_anchor_transactions_anchorTransactionId" ON anchor_transactions ("anchorTransactionId");`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS anchor_transactions;`);
  }
}
