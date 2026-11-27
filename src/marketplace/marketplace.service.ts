import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';
import { CreateListingDto, ListListingsQueryDto } from './dto/create-listing.dto';
import { ListingKind, MarketplaceListing, TradeMode } from './entities/marketplace-listing.entity';
import { ListingRating, MarketplaceReviewsService } from './marketplace-reviews.service';

export type MarketplaceListingResponse = MarketplaceListing & ListingRating;

@Injectable()
export class MarketplaceService {
  constructor(
    @InjectRepository(MarketplaceListing)
    private readonly listings: Repository<MarketplaceListing>,
    private readonly reviewsService: MarketplaceReviewsService,
  ) {}

  async create(sellerId: string, dto: CreateListingDto): Promise<MarketplaceListing> {
    // Same rules as the Soroban contract: personnel are hired, drugs are sold.
    const validMode =
      dto.kind === ListingKind.PERSONNEL
        ? dto.mode === TradeMode.HIRE
        : dto.kind === ListingKind.EQUIPMENT
          ? dto.mode !== TradeMode.HIRE
          : dto.mode === TradeMode.SALE;
    if (!validMode) {
      throw new BadRequestException(`A ${dto.kind} listing cannot use mode ${dto.mode}`);
    }

    const listing = this.listings.create({
      ...dto,
      sellerId,
      // Drugs and personnel need admin verification before they can be ordered.
      verified: dto.kind === ListingKind.EQUIPMENT,
      active: true,
    });
    return this.listings.save(listing);
  }

  /** Public catalogue: only active, verified listings, with their ratings. */
  async findAll(query: ListListingsQueryDto): Promise<MarketplaceListingResponse[]> {
    const listings = await this.listings.find({
      where: {
        active: true,
        verified: true,
        ...(query.kind && { kind: query.kind }),
        ...(query.mode && { mode: query.mode }),
        ...(query.search && { title: ILike(`%${query.search}%`) }),
      },
      order: { createdAt: 'DESC' },
      take: 100,
    });
    const ratings = await this.reviewsService.ratingsFor(listings.map((listing) => listing.id));
    return listings.map((listing) => this.withRating(listing, ratings));
  }

  async findOne(id: string): Promise<MarketplaceListingResponse> {
    const listing = await this.listings.findOne({ where: { id } });
    if (!listing) {
      throw new NotFoundException('Listing not found');
    }
    const ratings = await this.reviewsService.ratingsFor([listing.id]);
    return this.withRating(listing, ratings);
  }

  async verify(id: string): Promise<MarketplaceListing> {
    const listing = await this.findOne(id);
    listing.verified = true;
    return this.listings.save(listing);
  }

  async deactivate(id: string, sellerId: string): Promise<void> {
    const listing = await this.findOne(id);
    if (listing.sellerId !== sellerId) {
      throw new ForbiddenException('Only the seller can deactivate this listing');
    }
    listing.active = false;
    await this.listings.save(listing);
  }

  private withRating(
    listing: MarketplaceListing,
    ratings: Map<string, ListingRating>,
  ): MarketplaceListingResponse {
    return {
      ...listing,
      averageRating: ratings.get(listing.id)?.averageRating ?? 0,
      reviewCount: ratings.get(listing.id)?.reviewCount ?? 0,
    };
  }
}
