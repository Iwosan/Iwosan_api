import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Create cross_border_payments
 *
 * SEP-31 direct payments for marketplace orders and treatment campaigns,
 * including the SEP-12 customer ids registered with the anchor.
 */
export class CreateCrossBorderPayments1797000000001 implements MigrationInterface {
  name = 'CreateCrossBorderPayments1797000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE cross_border_payments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" varchar NOT NULL,
        "orderId" uuid,
        "campaignId" varchar,
        "senderCustomerId" varchar NOT NULL,
        "receiverCustomerId" varchar NOT NULL,
        "receiverAccount" varchar NOT NULL,
        amount decimal(18,7) NOT NULL,
        "assetCode" varchar NOT NULL,
        "anchorTransactionId" varchar,
        status varchar NOT NULL DEFAULT 'pending',
        "anchorHomeDomain" varchar NOT NULL,
        message text,
        "authToken" text,
        "rawResponse" jsonb,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "FK_cross_border_payments_order" FOREIGN KEY ("orderId")
          REFERENCES marketplace_orders(id) ON DELETE SET NULL
      );
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_cross_border_payments_userId" ON cross_border_payments ("userId");`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cross_border_payments_orderId" ON cross_border_payments ("orderId");`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cross_border_payments_anchorTransactionId" ON cross_border_payments ("anchorTransactionId");`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS cross_border_payments;`);
  }
}
