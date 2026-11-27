import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateReviewDto } from './dto/create-review.dto';
import { MarketplaceListing } from './entities/marketplace-listing.entity';
import { MarketplaceOrder, MarketplaceOrderStatus } from './entities/marketplace-order.entity';
import { MarketplaceReview } from './entities/marketplace-review.entity';
import { MarketplaceOrdersService } from './marketplace-orders.service';

export interface ListingRating {
  /** Mean rating rounded to two decimals, 0 when the listing has no reviews. */
  averageRating: number;
  reviewCount: number;
}

const UNIQUE_VIOLATION = '23505';

/**
 * Buyer reviews. Ratings cannot be faked: a review needs a released order that
 * the authenticated buyer actually placed, and each order can be reviewed once.
 */
@Injectable()
export class MarketplaceReviewsService {
  constructor(
    @InjectRepository(MarketplaceReview)
    private readonly reviews: Repository<MarketplaceReview>,
    @InjectRepository(MarketplaceListing)
    private readonly listings: Repository<MarketplaceListing>,
    @InjectRepository(MarketplaceOrder)
    private readonly orders: Repository<MarketplaceOrder>,
    private readonly ordersService: MarketplaceOrdersService,
  ) {}

  async create(
    listingId: string,
    userId: string,
    dto: CreateReviewDto,
  ): Promise<MarketplaceReview> {
    const listing = await this.listings.findOne({ where: { id: listingId } });
    if (!listing) {
      throw new NotFoundException('Listing not found');
    }

    const order = await this.orders.findOne({ where: { id: dto.orderId } });
    if (!order) {
      throw new NotFoundException('Order not found');
    }

    const address = await this.ordersService.stellarAddressFor(userId);
    if (!address || address !== order.buyerAddress) {
      throw new ForbiddenException('Only the buyer can review this order');
    }
    if (!listing.onChainListingId || order.onChainListingId !== listing.onChainListingId) {
      throw new BadRequestException('The order is not for this listing');
    }
    if (order.status !== MarketplaceOrderStatus.RELEASED) {
      throw new BadRequestException('Only completed orders can be reviewed');
    }

    const existing = await this.reviews.findOne({ where: { orderId: order.id } });
    if (existing) {
      throw new ConflictException('This order has already been reviewed');
    }

    const review = this.reviews.create({
      listingId: listing.id,
      orderId: order.id,
      reviewerId: userId,
      reviewerAddress: address,
      rating: dto.rating,
      comment: dto.comment ?? null,
    });

    try {
      return await this.reviews.save(review);
    } catch (error: unknown) {
      // Two concurrent submissions for the same order: the unique index wins.
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new ConflictException('This order has already been reviewed');
      }
      throw error;
    }
  }

  /** Aggregate rating for each listing id, keyed by listing id. */
  async ratingsFor(listingIds: string[]): Promise<Map<string, ListingRating>> {
    const ratings = new Map<string, ListingRating>();
    if (listingIds.length === 0) {
      return ratings;
    }

    const rows = await this.reviews
      .createQueryBuilder('review')
      .select('review.listingId', 'listingId')
      .addSelect('AVG(review.rating)', 'averageRating')
      .addSelect('COUNT(*)', 'reviewCount')
      .where('review.listingId IN (:...listingIds)', { listingIds })
      .groupBy('review.listingId')
      .getRawMany<{ listingId: string; averageRating: string; reviewCount: string }>();

    for (const row of rows) {
      ratings.set(row.listingId, {
        averageRating: Math.round(Number(row.averageRating) * 100) / 100,
        reviewCount: Number(row.reviewCount),
      });
    }
    return ratings;
  }
}
