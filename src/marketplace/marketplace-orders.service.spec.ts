import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  MarketplaceOrder,
  MarketplaceOrderStatus,
  MarketplacePaymentStatus,
} from './entities/marketplace-order.entity';
import { MarketplaceListing } from './entities/marketplace-listing.entity';
import { MarketplaceOrdersService } from './marketplace-orders.service';
import { User } from '../auth/entities/user.entity';

const BUYER = 'GBUYER123';
const SELLER = 'GSELLER123';

function makeOrder(overrides: Partial<MarketplaceOrder> = {}): MarketplaceOrder {
  return {
    id: 'order-uuid',
    onChainOrderId: '7',
    onChainListingId: '3',
    buyerAddress: BUYER,
    sellerAddress: SELLER,
    units: 2,
    amount: '300',
    currency: 'USDC',
    status: MarketplaceOrderStatus.ESCROWED,
    disputed: false,
    disputedAt: null,
    disputedBy: null,
    paymentStatus: MarketplacePaymentStatus.UNPAID,
    paidAt: null,
    txHash: null,
    ledger: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('MarketplaceOrdersService', () => {
  let service: MarketplaceOrdersService;
  let orders: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
  };
  let listings: { findOne: jest.Mock; save: jest.Mock };
  let users: { createQueryBuilder: jest.Mock };

  const mockUserAddress = (address: string | null) => {
    const builder = {
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue({ id: 'user-1', stellarPublicKey: address }),
    };
    users.createQueryBuilder.mockReturnValue(builder);
  };

  beforeEach(async () => {
    orders = {
      create: jest.fn((values: Partial<MarketplaceOrder>) => values),
      save: jest.fn((values: MarketplaceOrder) => Promise.resolve(values)),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
    };
    listings = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((values: MarketplaceListing) => Promise.resolve(values)),
    };
    users = { createQueryBuilder: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MarketplaceOrdersService,
        { provide: getRepositoryToken(MarketplaceOrder), useValue: orders },
        { provide: getRepositoryToken(MarketplaceListing), useValue: listings },
        { provide: getRepositoryToken(User), useValue: users },
      ],
    }).compile();

    service = module.get(MarketplaceOrdersService);
  });

  describe('recordOrder', () => {
    it('stores an ordered event as an escrowed order', async () => {
      const saved = await service.recordOrder({
        onChainOrderId: '7',
        onChainListingId: '3',
        buyerAddress: BUYER,
        sellerAddress: SELLER,
        units: 2,
        amount: '300',
        txHash: 'hash-1',
        ledger: 42,
      });

      expect(saved.onChainOrderId).toBe('7');
      expect(saved.status).toBe(MarketplaceOrderStatus.ESCROWED);
      expect(saved.amount).toBe('300');
      expect(saved.paymentStatus).toBe(MarketplacePaymentStatus.UNPAID);
      expect(orders.save).toHaveBeenCalledTimes(1);
    });

    it('is idempotent when the same event is replayed', async () => {
      const existing = makeOrder();
      orders.findOne.mockResolvedValueOnce(existing);

      const saved = await service.recordOrder({
        onChainOrderId: '7',
        onChainListingId: '3',
        buyerAddress: BUYER,
        sellerAddress: SELLER,
        units: 2,
        amount: '300',
      });

      expect(saved).toBe(existing);
      expect(orders.save).not.toHaveBeenCalled();
    });

    it('links the order to the listing with the same on-chain id', async () => {
      listings.findOne.mockResolvedValueOnce({ id: 'listing-uuid', currency: 'NGN' });

      const saved = await service.recordOrder({
        onChainOrderId: '7',
        onChainListingId: '3',
        buyerAddress: BUYER,
        sellerAddress: SELLER,
        units: 1,
        amount: '50',
      });

      expect(saved.currency).toBe('NGN');
      expect(listings.findOne).toHaveBeenCalledWith({
        where: { onChainListingId: '3' },
      });
    });

    it('treats a concurrent unique violation as an already indexed order', async () => {
      const existing = makeOrder();
      orders.save.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }));
      orders.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(existing);

      const saved = await service.recordOrder({
        onChainOrderId: '7',
        onChainListingId: '3',
        buyerAddress: BUYER,
        sellerAddress: SELLER,
        units: 2,
        amount: '300',
      });

      expect(saved).toBe(existing);
    });
  });

  describe('settleOrder', () => {
    it.each([
      [true, MarketplaceOrderStatus.RELEASED],
      [false, MarketplaceOrderStatus.REFUNDED],
    ])('marks the order settled (release=%s)', async (release, expected) => {
      const order = makeOrder();
      orders.findOne.mockResolvedValueOnce(order);

      const updated = await service.settleOrder('7', release);

      expect(updated?.status).toBe(expected);
      expect(orders.save).toHaveBeenCalledWith(order);
    });

    it('ignores a settlement for an order that was never indexed', async () => {
      orders.findOne.mockResolvedValueOnce(null);

      const updated = await service.settleOrder('999', true);

      expect(updated).toBeNull();
      expect(orders.save).not.toHaveBeenCalled();
    });
  });

  describe('findForUser', () => {
    it('queries buyer orders using the user Stellar address', async () => {
      mockUserAddress(BUYER);

      await service.findForUser('user-1', 'buyer');

      expect(orders.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { buyerAddress: BUYER } }),
      );
    });

    it('queries seller orders using the user Stellar address', async () => {
      mockUserAddress(SELLER);

      await service.findForUser('user-1', 'seller');

      expect(orders.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { sellerAddress: SELLER } }),
      );
    });

    it('returns no orders when the user has no Stellar address', async () => {
      mockUserAddress(null);

      await expect(service.findForUser('user-1', 'buyer')).resolves.toEqual([]);
      expect(orders.find).not.toHaveBeenCalled();
    });
  });

  describe('openDispute', () => {
    it('flags an escrowed order for a party to the order', async () => {
      orders.findOne.mockResolvedValueOnce(makeOrder());
      mockUserAddress(BUYER);

      const disputed = await service.openDispute('order-uuid', 'user-1');

      expect(disputed.disputed).toBe(true);
      expect(disputed.disputedBy).toBe(BUYER);
      expect(disputed.disputedAt).toBeInstanceOf(Date);
    });

    it('rejects unrelated users', async () => {
      orders.findOne.mockResolvedValueOnce(makeOrder());
      mockUserAddress('GSTRANGER');

      await expect(service.openDispute('order-uuid', 'user-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('rejects unknown orders', async () => {
      orders.findOne.mockResolvedValueOnce(null);
      mockUserAddress(BUYER);

      await expect(service.openDispute('missing', 'user-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects orders whose escrow is already closed', async () => {
      orders.findOne.mockResolvedValueOnce(makeOrder({ status: MarketplaceOrderStatus.RELEASED }));
      mockUserAddress(BUYER);

      await expect(service.openDispute('order-uuid', 'user-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('markPaid', () => {
    it('marks the payment as paid and records when it happened', async () => {
      orders.findOne.mockResolvedValueOnce(makeOrder());

      const paid = await service.markPaid('order-uuid', 'anchor-tx-1');

      expect(paid?.paymentStatus).toBe(MarketplacePaymentStatus.PAID);
      expect(paid?.paidAt).toBeInstanceOf(Date);
      expect(paid?.txHash).toBe('anchor-tx-1');
    });

    it('is idempotent', async () => {
      orders.findOne.mockResolvedValueOnce(
        makeOrder({ paymentStatus: MarketplacePaymentStatus.PAID }),
      );

      await service.markPaid('order-uuid');

      expect(orders.save).not.toHaveBeenCalled();
    });
  });
});
