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

@Injectable()
export class MarketplaceService {
  constructor(
    @InjectRepository(MarketplaceListing)
    private readonly listings: Repository<MarketplaceListing>,
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

  /** Public catalogue: only active, verified listings. */
  findAll(query: ListListingsQueryDto): Promise<MarketplaceListing[]> {
    return this.listings.find({
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
  }

  async findOne(id: string): Promise<MarketplaceListing> {
    const listing = await this.listings.findOne({ where: { id } });
    if (!listing) {
      throw new NotFoundException('Listing not found');
    }
    return listing;
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
}
