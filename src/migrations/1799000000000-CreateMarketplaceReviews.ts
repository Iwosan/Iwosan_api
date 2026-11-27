import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Create marketplace_reviews
 *
 * Buyer ratings for marketplace listings. `orderId` is unique so an order can
 * only ever earn one review, and `rating` is constrained to 1–5.
 */
export class CreateMarketplaceReviews1799000000000 implements MigrationInterface {
  name = 'CreateMarketplaceReviews1799000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE marketplace_reviews (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "listingId" uuid NOT NULL,
        "orderId" uuid NOT NULL,
        "reviewerId" varchar NOT NULL,
        "reviewerAddress" varchar NOT NULL,
        rating integer NOT NULL,
        comment text,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_marketplace_reviews_orderId" UNIQUE ("orderId"),
        CONSTRAINT "CHK_marketplace_reviews_rating" CHECK (rating BETWEEN 1 AND 5)
      );
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_marketplace_reviews_listingId" ON marketplace_reviews ("listingId");`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_marketplace_reviews_reviewerId" ON marketplace_reviews ("reviewerId");`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS marketplace_reviews;`);
  }
}
