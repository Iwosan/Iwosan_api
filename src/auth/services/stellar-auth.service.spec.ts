jest.unmock('@stellar/stellar-sdk');

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as StellarSdk from '@stellar/stellar-sdk';
import { StellarAuthService } from './stellar-auth.service';
import { PasswordValidationService } from './password-validation.service';
import { AuthTokenService } from './auth-token.service';
import { SessionManagementService } from './session-management.service';
import { RefreshTokenStoreService } from './refresh-token-store.service';
import { User, UserRole } from '../entities/user.entity';

const HOME_DOMAIN = 'iwosan.health';

describe('StellarAuthService (SEP-10)', () => {
  let service: StellarAuthService;
  let serverKeypair: StellarSdk.Keypair;
  let clientKeypair: StellarSdk.Keypair;
  let userRepository: {
    createQueryBuilder: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let authTokenService: { generateTokenPair: jest.Mock };
  let sessionManagementService: { createSession: jest.Mock };
  let refreshTokenStore: { store: jest.Mock };
  let queryBuilder: {
    addSelect: jest.Mock;
    where: jest.Mock;
    getOne: jest.Mock;
  };

  beforeEach(async () => {
    serverKeypair = StellarSdk.Keypair.random();
    clientKeypair = StellarSdk.Keypair.random();

    queryBuilder = {
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    };

    userRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      create: jest.fn((values: Partial<User>): User => values as User),
      save: jest.fn((user: User): Promise<User> =>
        Promise.resolve(user.id ? user : { ...user, id: 'stellar-user-1' }),
      ),
    };

    authTokenService = {
      generateTokenPair: jest.fn().mockReturnValue({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresIn: 900,
      }),
    };
    sessionManagementService = { createSession: jest.fn().mockResolvedValue(undefined) };
    refreshTokenStore = { store: jest.fn().mockResolvedValue(undefined) };

    const config: Record<string, string> = {
      STELLAR_WEB_AUTH_SECRET: serverKeypair.secret(),
      STELLAR_WEB_AUTH_DOMAIN: HOME_DOMAIN,
      STELLAR_NETWORK_PASSPHRASE: StellarSdk.Networks.TESTNET,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StellarAuthService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) => config[key] ?? defaultValue),
          },
        },
        { provide: 'UserRepository', useValue: userRepository },
        {
          provide: PasswordValidationService,
          useValue: { hashPassword: jest.fn().mockResolvedValue('unusable-hash') },
        },
        { provide: AuthTokenService, useValue: authTokenService },
        { provide: SessionManagementService, useValue: sessionManagementService },
        { provide: RefreshTokenStoreService, useValue: refreshTokenStore },
      ],
    })
      .overrideProvider('UserRepository')
      .useValue(userRepository)
      .compile();

    service = module.get(StellarAuthService);
  });

  function signChallenge(challenge: string, keypair = clientKeypair): string {
    const transaction = StellarSdk.TransactionBuilder.fromXDR(
      challenge,
      StellarSdk.Networks.TESTNET,
    ) as StellarSdk.Transaction;
    transaction.sign(keypair);
    return transaction.toEnvelope().toXDR('base64').toString();
  }

  describe('createChallenge', () => {
    it('returns a SEP-10 challenge signed by the server', () => {
      const result = service.createChallenge(clientKeypair.publicKey());

      expect(result.network_passphrase).toBe(StellarSdk.Networks.TESTNET);
      const read = StellarSdk.WebAuth.readChallengeTx(
        result.transaction,
        serverKeypair.publicKey(),
        StellarSdk.Networks.TESTNET,
        HOME_DOMAIN,
        HOME_DOMAIN,
      );
      expect(read.clientAccountID).toBe(clientKeypair.publicKey());
      expect(read.tx.source).toBe(serverKeypair.publicKey());
    });

    it('rejects an invalid Stellar account', () => {
      expect(() => service.createChallenge('not-a-stellar-key')).toThrow(BadRequestException);
    });
  });

  describe('authenticate', () => {
    it('verifies the signed challenge and issues tokens for a new wallet user', async () => {
      const challenge = service.createChallenge(clientKeypair.publicKey());
      const signed = signChallenge(challenge.transaction);

      const result = await service.authenticate(
        { account: clientKeypair.publicKey(), transaction: signed },
        '127.0.0.1',
        'jest',
      );

      expect(result.tokens).toEqual({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresIn: 900,
      });
      expect(result.user.email).toBe(
        `stellar-${clientKeypair.publicKey().toLowerCase()}@stellar.iwosan.local`,
      );
      expect(userRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          stellarPublicKey: clientKeypair.publicKey(),
          role: UserRole.PATIENT,
          isActive: true,
        }),
      );
      expect(sessionManagementService.createSession).toHaveBeenCalledWith(
        'stellar-user-1',
        'access-token',
        'refresh-token',
        expect.any(Date),
        expect.any(Date),
        '127.0.0.1',
        'jest',
      );
      expect(refreshTokenStore.store).toHaveBeenCalled();
    });

    it('links an existing user that already owns the Stellar account', async () => {
      const existingUser = {
        id: 'existing-user',
        email: 'patient@example.com',
        firstName: 'Ada',
        lastName: 'Obi',
        role: UserRole.PATIENT,
        isActive: true,
        mfaEnabled: false,
      } as User;
      queryBuilder.getOne.mockResolvedValue(existingUser);

      const challenge = service.createChallenge(clientKeypair.publicKey());
      const result = await service.authenticate(
        {
          account: clientKeypair.publicKey(),
          transaction: signChallenge(challenge.transaction),
        },
        '127.0.0.1',
        'jest',
      );

      expect(result.user.id).toBe('existing-user');
      expect(userRepository.create).not.toHaveBeenCalled();
    });

    it('rejects a challenge signed by a different key than the claimed account', async () => {
      const challenge = service.createChallenge(clientKeypair.publicKey());
      const signedByAttacker = signChallenge(challenge.transaction, StellarSdk.Keypair.random());

      await expect(
        service.authenticate(
          {
            account: clientKeypair.publicKey(),
            transaction: signedByAttacker,
          },
          '127.0.0.1',
          'jest',
        ),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects an expired challenge', async () => {
      const expired = StellarSdk.WebAuth.buildChallengeTx(
        serverKeypair,
        clientKeypair.publicKey(),
        HOME_DOMAIN,
        -1000,
        StellarSdk.Networks.TESTNET,
        HOME_DOMAIN,
      );

      await expect(
        service.authenticate(
          {
            account: clientKeypair.publicKey(),
            transaction: signChallenge(expired),
          },
          '127.0.0.1',
          'jest',
        ),
      ).rejects.toThrow(/expired/i);
    });

    it('rejects a tampered challenge envelope', async () => {
      const challenge = service.createChallenge(clientKeypair.publicKey());
      const signed = signChallenge(challenge.transaction);
      const tampered = `${signed.slice(0, 20)}A${signed.slice(21)}`;

      await expect(
        service.authenticate(
          { account: clientKeypair.publicKey(), transaction: tampered },
          '127.0.0.1',
          'jest',
        ),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects replayed challenges', async () => {
      const challenge = service.createChallenge(clientKeypair.publicKey());
      const signed = signChallenge(challenge.transaction);
      const payload = {
        account: clientKeypair.publicKey(),
        transaction: signed,
      };

      await service.authenticate(payload, '127.0.0.1', 'jest');
      await expect(service.authenticate(payload, '127.0.0.1', 'jest')).rejects.toThrow(
        /already been used/i,
      );
    });

    it('rejects inactive users', async () => {
      queryBuilder.getOne.mockResolvedValue({
        id: 'inactive',
        email: 'inactive@example.com',
        isActive: false,
        mfaEnabled: false,
      });

      const challenge = service.createChallenge(clientKeypair.publicKey());
      await expect(
        service.authenticate(
          {
            account: clientKeypair.publicKey(),
            transaction: signChallenge(challenge.transaction),
          },
          '127.0.0.1',
          'jest',
        ),
      ).rejects.toThrow(/inactive/i);
    });
  });
});
