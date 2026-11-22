import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Create marketplace_listings
 *
 * Catalogue table for the Iwosan marketplace (medical equipment sale/rental,
 * orthodox and native drugs, medical personnel hire). Payments and escrow are
 * handled on-chain by the `iwosan-marketplace` Soroban contract.
 */
export class CreateMarketplaceListings1795000000000 implements MigrationInterface {
  name = 'CreateMarketplaceListings1795000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE marketplace_listings_kind_enum AS ENUM
        ('equipment', 'orthodox_drug', 'native_drug', 'personnel');
    `);
    await queryRunner.query(`
      CREATE TYPE marketplace_listings_mode_enum AS ENUM ('sale', 'rental', 'hire');
    `);
    await queryRunner.query(`
      CREATE TABLE marketplace_listings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "sellerId" varchar NOT NULL,
        "sellerStellarAddress" varchar NOT NULL,
        kind marketplace_listings_kind_enum NOT NULL,
        mode marketplace_listings_mode_enum NOT NULL,
        title varchar NOT NULL,
        description text,
        "unitPrice" decimal(18,7) NOT NULL,
        currency varchar NOT NULL DEFAULT 'USDC',
        stock integer NOT NULL DEFAULT 0,
        location varchar,
        "regulatoryNumber" varchar,
        "onChainListingId" bigint,
        verified boolean NOT NULL DEFAULT false,
        active boolean NOT NULL DEFAULT true,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_marketplace_listings_sellerId" ON marketplace_listings ("sellerId");`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_marketplace_listings_kind" ON marketplace_listings (kind);`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS marketplace_listings;`);
    await queryRunner.query(`DROP TYPE IF EXISTS marketplace_listings_mode_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS marketplace_listings_kind_enum;`);
  }
}
