import { BadRequestException, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KeyStore } from '../../key-management/interfaces/key-store.interface';
import { StellarSponsorshipService } from './stellar-sponsorship.service';

// ── Mock @stellar/stellar-sdk (the global unit-test stub is too small) ─────

const mockLoadAccount = jest.fn();
const mockSubmitTransaction = jest.fn();
const mockSign = jest.fn();
const mockToXDR = jest.fn().mockReturnValue('built-xdr');
const mockAddOperation = jest.fn();
let mockFromXDR: jest.Mock;

jest.mock('@stellar/stellar-sdk', () => {
  const actual: typeof import('@stellar/stellar-sdk') = jest.requireActual('@stellar/stellar-sdk');

  class MockTransactionBuilder {
    static fromXDR = (...args: unknown[]): unknown => mockFromXDR(...args);
    addOperation(op: unknown) {
      mockAddOperation(op);
      return this;
    }
    setTimeout() {
      return this;
    }
    build() {
      return { sign: mockSign, toXDR: mockToXDR };
    }
  }

  class MockFeeBumpTransaction {
    fee = '2000000';
    constructor(
      public readonly feeSource: { publicKey: () => string },
      public readonly baseFee: string,
      public readonly inner: unknown,
      public readonly passphrase: string,
    ) {}
    sign = mockSign;
  }

  class MockAsset {
    constructor(
      private readonly code: string,
      private readonly issuer: string,
    ) {}
    getCode() {
      return this.code;
    }
    getIssuer() {
      return this.issuer;
    }
  }

  return {
    ...actual,
    Horizon: {
      Server: jest.fn().mockImplementation(() => ({
        loadAccount: mockLoadAccount,
        submitTransaction: mockSubmitTransaction,
      })),
    },
    TransactionBuilder: MockTransactionBuilder,
    FeeBumpTransaction: MockFeeBumpTransaction,
    Asset: MockAsset,
    BASE_FEE: '100',
    Operation: {
      beginSponsoringFutureReserves: jest.fn((op: Record<string, unknown>) => ({
        type: 'begin',
        ...op,
      })),
      createAccount: jest.fn((op: Record<string, unknown>) => ({ type: 'create', ...op })),
      changeTrust: jest.fn((op: Record<string, unknown>) => ({ type: 'trust', ...op })),
      endSponsoringFutureReserves: jest.fn((op: Record<string, unknown>) => ({
        type: 'end',
        ...op,
      })),
    },
    Keypair: {
      fromSecret: jest.fn((secret: string) => ({
        secret,
        publicKey: () => 'GSPONSOR',
        sign: mockSign,
      })),
    },
    Networks: actual.Networks,
  };
});

const SPONSOR_SECRET = 'S_SPONSOR_SECRET';

function makeService(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    STELLAR_SPONSOR_SECRET: SPONSOR_SECRET,
    STELLAR_FEE_ACCOUNT_SECRET: 'S_FEE_SECRET',
    STELLAR_SPONSOR_RATE_LIMIT: '5',
    STELLAR_FEE_BUMP_RATE_LIMIT: '30',
    ...overrides,
  };
  const config = {
    get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback),
  } as unknown as ConfigService;
  const keyStore: KeyStore = {
    retrieveKey: jest.fn().mockRejectedValue(new Error('not in key store')),
    storeKey: jest.fn(),
    deleteKey: jest.fn(),
    listKeys: jest.fn(),
    rotateWrappingKey: jest.fn(),
  };
  return { service: new StellarSponsorshipService(config, keyStore), keyStore };
}

describe('StellarSponsorshipService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadAccount.mockResolvedValue({ accountId: () => 'GSPONSOR', sequenceNumber: () => '1' });
    mockSubmitTransaction.mockResolvedValue({ hash: 'submitted-hash', source_account: 'GUSER' });
    mockFromXDR = jest.fn().mockReturnValue({ inner: true });
  });

  describe('sponsorAccount', () => {
    it('builds a sponsored account transaction with the USDC trustline', async () => {
      const { service } = makeService();

      const result = await service.sponsorAccount('user-1', 'GUSER');

      expect(mockLoadAccount).toHaveBeenCalledWith('GSPONSOR');
      expect(mockAddOperation).toHaveBeenCalledTimes(4);
      expect(mockSign).toHaveBeenCalled();
      expect(result).toMatchObject({ xdr: 'built-xdr', sponsor: 'GSPONSOR' });
      expect((result as { usdcAsset: string }).usdcAsset).toContain('USDC:');
    });

    it('submits the signed transaction to create the account', async () => {
      const { service } = makeService();

      const result = await service.sponsorAccount('user-1', 'GUSER', 'signed-xdr');

      expect(mockSubmitTransaction).toHaveBeenCalled();
      expect(result).toEqual({ hash: 'submitted-hash', sponsor: 'GUSER' });
    });

    it('uses the key store before falling back to env secrets', async () => {
      const { service, keyStore } = makeService();
      (keyStore.retrieveKey as jest.Mock).mockResolvedValueOnce('S_FROM_KEY_STORE');

      await service.sponsorAccount('user-1', 'GUSER');

      expect((keyStore.retrieveKey as jest.Mock).mock.calls).toEqual([['stellar:sponsor-account']]);
    });

    it('enforces the per-user sponsorship limit', async () => {
      const { service } = makeService({ STELLAR_SPONSOR_RATE_LIMIT: '1' });

      await service.sponsorAccount('user-1', 'GUSER');

      await expect(service.sponsorAccount('user-1', 'GUSER')).rejects.toBeInstanceOf(HttpException);
      // Another user still has their own allowance.
      await expect(service.sponsorAccount('user-2', 'GUSER')).resolves.toBeDefined();
    });
  });

  describe('submitFeeBump', () => {
    it('wraps the inner transaction and submits it', async () => {
      const { service } = makeService();

      const result = await service.submitFeeBump('user-1', 'inner-xdr');

      expect(mockFromXDR).toHaveBeenCalledWith('inner-xdr', expect.any(String));
      expect(mockSign).toHaveBeenCalled();
      expect(result).toEqual({
        hash: 'submitted-hash',
        feeAccount: 'GSPONSOR',
        maxFee: '2000000',
      });
    });

    it('rejects malformed XDR', async () => {
      mockFromXDR.mockImplementationOnce(() => {
        throw new Error('bad xdr');
      });
      const { service } = makeService();

      await expect(service.submitFeeBump('user-1', 'nope')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('enforces the per-user fee-bump limit', async () => {
      const { service } = makeService({ STELLAR_FEE_BUMP_RATE_LIMIT: '1' });

      await service.submitFeeBump('user-1', 'inner-xdr');

      await expect(service.submitFeeBump('user-1', 'inner-xdr')).rejects.toBeInstanceOf(
        HttpException,
      );
    });
  });
});
