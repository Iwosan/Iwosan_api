import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  MarketplaceOrder,
  MarketplaceOrderStatus,
  MarketplacePaymentStatus,
} from './entities/marketplace-order.entity';
import { ListingKind, MarketplaceListing, TradeMode } from './entities/marketplace-listing.entity';
import { MarketplaceReview } from './entities/marketplace-review.entity';
import { MarketplaceOrdersService } from './marketplace-orders.service';
import { MarketplaceReviewsService } from './marketplace-reviews.service';

const BUYER = 'GBUYER123';

function makeListing(overrides: Partial<MarketplaceListing> = {}): MarketplaceListing {
  return {
    id: 'listing-uuid',
    sellerId: 'seller-uuid',
    sellerStellarAddress: 'GSELLER123',
    kind: ListingKind.EQUIPMENT,
    mode: TradeMode.SALE,
    title: 'Oxygen concentrator',
    description: 'Refurbished',
    unitPrice: '300',
    currency: 'USDC',
    stock: 2,
    location: 'Lagos',
    regulatoryNumber: null,
    onChainListingId: '3',
    verified: true,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeOrder(overrides: Partial<MarketplaceOrder> = {}): MarketplaceOrder {
  return {
    id: 'order-uuid',
    onChainOrderId: '7',
    onChainListingId: '3',
    buyerAddress: BUYER,
    sellerAddress: 'GSELLER123',
    units: 1,
    amount: '300',
    currency: 'USDC',
    status: MarketplaceOrderStatus.RELEASED,
    disputed: false,
    disputedAt: null,
    disputedBy: null,
    paymentStatus: MarketplacePaymentStatus.PAID,
    paidAt: null,
    batchId: null,
    txHash: null,
    ledger: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('MarketplaceReviewsService', () => {
  let service: MarketplaceReviewsService;
  let reviews: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let listings: { findOne: jest.Mock };
  let orders: { findOne: jest.Mock };
  let ordersService: { stellarAddressFor: jest.Mock };

  beforeEach(async () => {
    reviews = {
      create: jest.fn((values: Partial<MarketplaceReview>) => values),
      save: jest.fn((values: MarketplaceReview) => Promise.resolve(values)),
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(),
    };
    listings = { findOne: jest.fn().mockResolvedValue(makeListing()) };
    orders = { findOne: jest.fn().mockResolvedValue(makeOrder()) };
    ordersService = { stellarAddressFor: jest.fn().mockResolvedValue(BUYER) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MarketplaceReviewsService,
        { provide: getRepositoryToken(MarketplaceReview), useValue: reviews },
        { provide: getRepositoryToken(MarketplaceListing), useValue: listings },
        { provide: getRepositoryToken(MarketplaceOrder), useValue: orders },
        { provide: MarketplaceOrdersService, useValue: ordersService },
      ],
    }).compile();

    service = module.get(MarketplaceReviewsService);
  });

  it('stores a review for the buyer of a released order', async () => {
    const review = await service.create('listing-uuid', 'user-1', {
      orderId: 'order-uuid',
      rating: 5,
      comment: 'Arrived quickly',
    });

    expect(review.listingId).toBe('listing-uuid');
    expect(review.orderId).toBe('order-uuid');
    expect(review.reviewerAddress).toBe(BUYER);
    expect(review.rating).toBe(5);
    expect(reviews.save).toHaveBeenCalledTimes(1);
  });

  it('rejects a second review for the same order', async () => {
    reviews.findOne.mockResolvedValueOnce({ id: 'existing' });

    await expect(
      service.create('listing-uuid', 'user-1', { orderId: 'order-uuid', rating: 4 }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(reviews.save).not.toHaveBeenCalled();
  });

  it('turns a concurrent duplicate insert into a conflict', async () => {
    reviews.save.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }));

    await expect(
      service.create('listing-uuid', 'user-1', { orderId: 'order-uuid', rating: 4 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects orders that are not released yet', async () => {
    orders.findOne.mockResolvedValueOnce(makeOrder({ status: MarketplaceOrderStatus.ESCROWED }));

    await expect(
      service.create('listing-uuid', 'user-1', { orderId: 'order-uuid', rating: 4 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects orders belonging to another buyer', async () => {
    ordersService.stellarAddressFor.mockResolvedValueOnce('GSTRANGER');

    await expect(
      service.create('listing-uuid', 'user-1', { orderId: 'order-uuid', rating: 4 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects users without a Stellar address', async () => {
    ordersService.stellarAddressFor.mockResolvedValueOnce(null);

    await expect(
      service.create('listing-uuid', 'user-1', { orderId: 'order-uuid', rating: 4 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects an order for a different listing', async () => {
    orders.findOne.mockResolvedValueOnce(makeOrder({ onChainListingId: '99' }));

    await expect(
      service.create('listing-uuid', 'user-1', { orderId: 'order-uuid', rating: 4 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a listing that has no on-chain id', async () => {
    listings.findOne.mockResolvedValueOnce(makeListing({ onChainListingId: null }));

    await expect(
      service.create('listing-uuid', 'user-1', { orderId: 'order-uuid', rating: 4 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns 404 for an unknown listing or order', async () => {
    listings.findOne.mockResolvedValueOnce(null);
    await expect(
      service.create('missing', 'user-1', { orderId: 'order-uuid', rating: 4 }),
    ).rejects.toBeInstanceOf(NotFoundException);

    orders.findOne.mockResolvedValueOnce(null);
    await expect(
      service.create('listing-uuid', 'user-1', { orderId: 'missing', rating: 4 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('ratingsFor', () => {
    it('returns an empty map without querying when there are no listings', async () => {
      await expect(service.ratingsFor([])).resolves.toEqual(new Map());
      expect(reviews.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('averages ratings per listing', async () => {
      const builder = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest
          .fn()
          .mockResolvedValue([
            { listingId: 'listing-uuid', averageRating: '4.333', reviewCount: '3' },
          ]),
      };
      reviews.createQueryBuilder.mockReturnValue(builder);

      const ratings = await service.ratingsFor(['listing-uuid']);

      expect(ratings.get('listing-uuid')).toEqual({ averageRating: 4.33, reviewCount: 3 });
    });
  });
});
