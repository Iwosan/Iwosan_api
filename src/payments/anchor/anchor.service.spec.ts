import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { BadGatewayException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { AnchorService } from './anchor.service';
import { AnchorTransaction } from './entities/anchor-transaction.entity';

const TOML = `
ACCOUNTS = ["GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"]
TRANSFER_SERVER_SEP0024 = "https://testanchor.stellar.org/sep24"
VERSION = "1.0.0"
`;

const ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

describe('AnchorService (SEP-24)', () => {
  let service: AnchorService;
  let httpService: { get: jest.Mock; post: jest.Mock };
  let transactions: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
  };

  beforeEach(async () => {
    httpService = {
      get: jest.fn((url: string) => {
        if (url.endsWith('/.well-known/stellar.toml')) {
          return of({ data: TOML });
        }
        if (url.endsWith('/transaction')) {
          return of({
            data: { transaction: { id: 'anchor-tx-1', status: 'completed' } },
          });
        }
        return throwError(() => new Error(`Unexpected URL: ${url}`));
      }),
      post: jest.fn().mockReturnValue(
        of({
          data: {
            type: 'interactive_customer_info_needed',
            url: 'https://testanchor.stellar.org/sep24/interactive/abc',
            id: 'anchor-tx-1',
          },
        }),
      ),
    };

    transactions = {
      create: jest.fn(
        (values: Partial<AnchorTransaction>): AnchorTransaction => values as AnchorTransaction,
      ),
      save: jest.fn((transaction: AnchorTransaction): Promise<AnchorTransaction> =>
        Promise.resolve(transaction.id ? transaction : { ...transaction, id: 'local-tx-1' }),
      ),
      find: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnchorService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) => {
              const config: Record<string, string> = {
                ANCHOR_HOME_DOMAIN: 'testanchor.stellar.org',
                ANCHOR_ASSET_CODE: 'USDC',
              };
              return config[key] ?? defaultValue;
            }),
          },
        },
        { provide: HttpService, useValue: httpService },
        { provide: 'AnchorTransactionRepository', useValue: transactions },
      ],
    }).compile();

    service = module.get(AnchorService);
  });

  it('starts an interactive deposit and persists the anchor transaction', async () => {
    const result = await service.startDeposit({ account: ACCOUNT }, 'user-1');

    expect(httpService.post).toHaveBeenCalledWith(
      'https://testanchor.stellar.org/sep24/transactions/deposit/interactive',
      JSON.stringify({ asset_code: 'USDC', account: ACCOUNT }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    expect(transactions.save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        direction: 'deposit',
        account: ACCOUNT,
        assetCode: 'USDC',
        anchorTransactionId: 'anchor-tx-1',
        status: 'incomplete',
        anchorHomeDomain: 'testanchor.stellar.org',
      }),
    );
    expect(result).toMatchObject({
      id: 'local-tx-1',
      direction: 'deposit',
      status: 'incomplete',
      url: 'https://testanchor.stellar.org/sep24/interactive/abc',
      anchorTransactionId: 'anchor-tx-1',
    });
  });

  it('starts an interactive withdrawal with a custom asset and amount', async () => {
    await service.startWithdraw(
      { account: ACCOUNT, assetCode: 'NGNT', amount: '1500.50' },
      'user-2',
    );

    const [url, body] = httpService.post.mock.calls[0] as [string, string];
    expect(url).toBe('https://testanchor.stellar.org/sep24/transactions/withdraw/interactive');
    expect(JSON.parse(body)).toEqual({
      asset_code: 'NGNT',
      account: ACCOUNT,
      amount: '1500.50',
    });
  });

  it('forwards the wallet SEP-10 token and derives the id from the interactive URL', async () => {
    httpService.post.mockReturnValueOnce(
      of({
        data: {
          type: 'interactive_customer_info_needed',
          url: 'https://testanchor.stellar.org/sep24/interactive/abc?transaction_id=url-tx-1',
        },
      }),
    );

    const result = await service.startDeposit(
      { account: ACCOUNT, authToken: 'sep10-jwt' },
      'user-1',
    );

    expect(httpService.post).toHaveBeenCalledWith(
      'https://testanchor.stellar.org/sep24/transactions/deposit/interactive',
      expect.any(String),
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer sep10-jwt',
        },
      },
    );
    expect(transactions.save).toHaveBeenCalledWith(
      expect.objectContaining({
        anchorTransactionId: 'url-tx-1',
        authToken: 'sep10-jwt',
      }),
    );
    expect(result.anchorTransactionId).toBe('url-tx-1');
  });

  it('rejects a response without an interactive URL', async () => {
    httpService.post.mockReturnValueOnce(of({ data: { type: 'error' } }));

    await expect(service.startDeposit({ account: ACCOUNT }, 'user-1')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('fails clearly when the anchor has no SEP-24 server', async () => {
    httpService.get.mockReturnValueOnce(of({ data: 'NETWORK_PASSPHRASE="x"' }));

    await expect(service.startDeposit({ account: ACCOUNT }, 'user-1')).rejects.toThrow(/SEP-24/);
  });

  it('translates anchor HTTP errors into a bad gateway error', async () => {
    httpService.post.mockReturnValueOnce(throwError(() => new Error('anchor down')));

    await expect(service.startDeposit({ account: ACCOUNT }, 'user-1')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('persists status updates pulled from the anchor', async () => {
    const pending = {
      id: 'local-tx-1',
      userId: 'user-1',
      direction: 'deposit',
      account: ACCOUNT,
      assetCode: 'USDC',
      anchorTransactionId: 'anchor-tx-1',
      status: 'incomplete',
      anchorHomeDomain: 'testanchor.stellar.org',
      message: null,
      authToken: 'sep10-jwt',
      rawResponse: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } as AnchorTransaction;
    transactions.find.mockResolvedValue([{ ...pending }]);

    const updated = await service.refreshPendingTransactions();

    expect(updated).toBe(1);
    expect(transactions.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'local-tx-1', status: 'completed' }),
    );
    expect(httpService.get).toHaveBeenCalledWith(
      'https://testanchor.stellar.org/sep24/transaction',
      {
        params: { id: 'anchor-tx-1' },
        headers: { Authorization: 'Bearer sep10-jwt' },
      },
    );
  });

  it('does not write rows whose status has not changed', async () => {
    transactions.find.mockResolvedValue([
      {
        id: 'local-tx-1',
        anchorTransactionId: 'anchor-tx-1',
        status: 'completed',
      },
    ]);
    httpService.get.mockImplementation((url: string) => {
      if (url.endsWith('/.well-known/stellar.toml')) {
        return of({ data: TOML });
      }
      return of({ data: { transaction: { status: 'completed' } } });
    });

    const updated = await service.refreshPendingTransactions();

    expect(updated).toBe(0);
    expect(transactions.save).not.toHaveBeenCalled();
  });

  it('keeps polling when one anchor status request fails', async () => {
    transactions.find.mockResolvedValue([
      {
        id: 'local-tx-1',
        anchorTransactionId: 'anchor-tx-1',
        status: 'pending_user_transfer_start',
      },
    ]);
    httpService.get.mockImplementation((url: string) => {
      if (url.endsWith('/.well-known/stellar.toml')) {
        return of({ data: TOML });
      }
      return throwError(() => new Error('timeout'));
    });

    await expect(service.refreshPendingTransactions()).resolves.toBe(0);
  });
});
