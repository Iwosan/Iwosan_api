import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Create marketplace_orders
 *
 * Projection of the `iwosan-marketplace` contract's `ordered` and `settled`
 * events. `onChainOrderId` is unique so replaying the event stream is
 * idempotent; `onChainListingId` links the order to the listing catalogue.
 */
export class CreateMarketplaceOrders1797000000000 implements MigrationInterface {
  name = 'CreateMarketplaceOrders1797000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE marketplace_orders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "onChainOrderId" bigint NOT NULL,
        "onChainListingId" bigint,
        "buyerAddress" varchar NOT NULL,
        "sellerAddress" varchar NOT NULL,
        units integer NOT NULL,
        amount decimal(18,7) NOT NULL,
        currency varchar NOT NULL DEFAULT 'USDC',
        status varchar NOT NULL DEFAULT 'escrowed',
        disputed boolean NOT NULL DEFAULT false,
        "disputedAt" timestamptz,
        "disputedBy" varchar,
        "paymentStatus" varchar NOT NULL DEFAULT 'unpaid',
        "paidAt" timestamptz,
        "txHash" varchar,
        ledger integer,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_marketplace_orders_onChainOrderId" UNIQUE ("onChainOrderId")
      );
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_marketplace_orders_onChainListingId" ON marketplace_orders ("onChainListingId");`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_marketplace_orders_buyerAddress" ON marketplace_orders ("buyerAddress");`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_marketplace_orders_sellerAddress" ON marketplace_orders ("sellerAddress");`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS marketplace_orders;`);
  }
}
