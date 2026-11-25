import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { of, throwError } from 'rxjs';
import { CrossBorderService } from './cross-border.service';
import { CrossBorderPayment } from './entities/cross-border-payment.entity';
import { MarketplaceOrdersService } from '../../marketplace/marketplace-orders.service';

const SENDER_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const RECEIVER_ACCOUNT = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const TOML = `
DIRECT_PAYMENT_SERVER = "https://testanchor.stellar.org/sep31"
KYC_SERVER = "https://testanchor.stellar.org/sep12"
`;

const dto = {
  orderId: 'order-uuid',
  amount: '100',
  sender: { account: SENDER_ACCOUNT, firstName: 'Ada', lastName: 'Obi' },
  receiver: { account: RECEIVER_ACCOUNT },
  authToken: 'anchor-jwt',
};

describe('CrossBorderService (SEP-31)', () => {
  let service: CrossBorderService;
  let http: { get: jest.Mock; post: jest.Mock; put: jest.Mock };
  let payments: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
  };
  let orders: { markPaid: jest.Mock };

  beforeEach(async () => {
    http = {
      get: jest.fn((url: string) => {
        if (url.endsWith('/.well-known/stellar.toml')) {
          return of({ data: TOML });
        }
        if (url.includes('/transactions/')) {
          return of({ data: { transaction: { id: 'anchor-tx-1', status: 'completed' } } });
        }
        return throwError(() => new Error(`Unexpected GET ${url}`));
      }),
      post: jest
        .fn()
        .mockReturnValue(
          of({ data: { id: 'anchor-tx-1', status: 'pending_user_transfer_start' } }),
        ),
      put: jest.fn((url: string) =>
        of({
          data: { id: url.includes('sender') ? 'sender-1' : 'receiver-1' },
        }),
      ),
    };
    // Register distinct customer ids: first PUT is the sender, second the receiver.
    let customer = 0;
    http.put.mockImplementation(() => {
      customer += 1;
      return of({ data: { id: `customer-${customer}` } });
    });

    payments = {
      create: jest.fn((values: Partial<CrossBorderPayment>) => values),
      save: jest.fn((values: CrossBorderPayment) =>
        Promise.resolve({
          ...values,
          id: values.id ?? 'payment-uuid',
          createdAt: values.createdAt ?? new Date(),
        }),
      ),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
    };
    orders = { markPaid: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrossBorderService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, fallback?: string) => {
              const values: Record<string, string> = {
                ANCHOR_HOME_DOMAIN: 'testanchor.stellar.org',
                ANCHOR_ASSET_CODE: 'USDC',
              };
              return values[key] ?? fallback;
            }),
          },
        },
        { provide: HttpService, useValue: http },
        { provide: getRepositoryToken(CrossBorderPayment), useValue: payments },
        { provide: MarketplaceOrdersService, useValue: orders },
      ],
    }).compile();

    service = module.get(CrossBorderService);
  });

  it('registers SEP-12 customers and starts a SEP-31 transaction', async () => {
    const result = await service.initiate(dto, 'user-1');

    expect(http.put).toHaveBeenCalledWith(
      'https://testanchor.stellar.org/sep12/customer',
      expect.stringContaining(SENDER_ACCOUNT),
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer anchor-jwt',
        },
      },
    );
    expect(http.post).toHaveBeenCalledWith(
      'https://testanchor.stellar.org/sep31/transactions',
      expect.stringContaining('"sender_id":"customer-1"'),
      expect.anything(),
    );
    expect(result).toMatchObject({
      id: 'payment-uuid',
      status: 'pending_user_transfer_start',
      senderCustomerId: 'customer-1',
      receiverCustomerId: 'customer-2',
      orderId: 'order-uuid',
    });
    expect(payments.save).toHaveBeenCalled();
  });

  it('reuses customer ids supplied by the caller', async () => {
    await service.initiate(
      {
        ...dto,
        sender: { ...dto.sender, customerId: 'known-sender' },
        receiver: { ...dto.receiver, customerId: 'known-receiver' },
      },
      'user-1',
    );

    expect(http.put).not.toHaveBeenCalled();
    expect(http.post).toHaveBeenCalledWith(
      'https://testanchor.stellar.org/sep31/transactions',
      expect.stringContaining('"receiver_id":"known-receiver"'),
      expect.anything(),
    );
  });

  it('requires an order or a campaign', async () => {
    await expect(service.initiate({ ...dto, orderId: undefined }, 'user-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a payment when the anchor refuses it', async () => {
    http.post.mockReturnValueOnce(throwError(() => new Error('anchor down')));

    await expect(service.initiate(dto, 'user-1')).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('marks the order paid when the anchor completes the payment', async () => {
    payments.find.mockResolvedValueOnce([
      {
        id: 'payment-uuid',
        orderId: 'order-uuid',
        anchorTransactionId: 'anchor-tx-1',
        status: 'pending_user_transfer_start',
        anchorHomeDomain: 'testanchor.stellar.org',
        authToken: 'anchor-jwt',
        message: null,
        rawResponse: null,
      } as CrossBorderPayment,
    ]);

    const updated = await service.refreshPendingPayments();

    expect(updated).toBe(1);
    expect(payments.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    expect(orders.markPaid).toHaveBeenCalledWith('order-uuid', 'anchor-tx-1');
  });

  it('does not mark the order paid while the payment is incomplete', async () => {
    http.get.mockImplementation((url: string) => {
      if (url.endsWith('/.well-known/stellar.toml')) {
        return of({ data: TOML });
      }
      return of({ data: { transaction: { status: 'pending_stellar' } } });
    });
    payments.find.mockResolvedValueOnce([
      {
        id: 'payment-uuid',
        orderId: 'order-uuid',
        anchorTransactionId: 'anchor-tx-1',
        status: 'pending_user_transfer_start',
        anchorHomeDomain: 'testanchor.stellar.org',
        message: null,
        rawResponse: null,
      } as CrossBorderPayment,
    ]);

    await service.refreshPendingPayments();

    expect(orders.markPaid).not.toHaveBeenCalled();
  });

  it('only returns a payment to its owner', async () => {
    payments.findOne.mockResolvedValueOnce({
      id: 'payment-uuid',
      userId: 'someone-else',
    });

    await expect(service.findOne('payment-uuid', 'user-1')).rejects.toThrow(
      'Cross-border payment not found',
    );
  });
});
