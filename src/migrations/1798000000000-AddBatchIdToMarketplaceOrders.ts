import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Add batchId to marketplace_orders
 *
 * Records which `drug-batch-registry` batch a drug order was fulfilled from,
 * so buyers can be notified when that batch is recalled.
 */
export class AddBatchIdToMarketplaceOrders1798000000000 implements MigrationInterface {
  name = 'AddBatchIdToMarketplaceOrders1798000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS "batchId" varchar(64);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_marketplace_orders_batchId" ON marketplace_orders ("batchId");`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_marketplace_orders_batchId";`);
    await queryRunner.query(`ALTER TABLE marketplace_orders DROP COLUMN IF EXISTS "batchId";`);
  }
}
