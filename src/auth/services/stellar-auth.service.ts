import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import * as StellarSdk from '@stellar/stellar-sdk';
import { User, UserRole } from '../entities/user.entity';
import { PasswordValidationService } from './password-validation.service';
import { AuthTokenService } from './auth-token.service';
import { SessionManagementService } from './session-management.service';
import { RefreshTokenStoreService } from './refresh-token-store.service';
import type { AuthResponse } from './auth.service';
import { describeError } from '../../common/utils/describe-error.util';
import { StellarTokenDto } from '../dto/stellar-auth.dto';

/** SEP-10 challenges are valid for five minutes, as recommended by the spec. */
export const CHALLENGE_TIMEOUT_SECONDS = 300;

export interface StellarChallengeResponse {
  /** Base64-encoded challenge envelope for the wallet to sign. */
  transaction: string;
  network_passphrase: string;
}

@Injectable()
export class StellarAuthService {
  private readonly logger = new Logger(StellarAuthService.name);

  private readonly serverKeypair: StellarSdk.Keypair;
  private readonly networkPassphrase: string;
  private readonly homeDomain: string;

  /** Challenge hashes already exchanged for tokens, with their expiry (ms). */
  private readonly usedChallenges = new Map<string, number>();

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly passwordValidationService: PasswordValidationService,
    private readonly authTokenService: AuthTokenService,
    private readonly sessionManagementService: SessionManagementService,
    private readonly refreshTokenStore: RefreshTokenStoreService,
  ) {
    this.networkPassphrase = this.resolveNetworkPassphrase();
    this.homeDomain = this.configService.get<string>('STELLAR_WEB_AUTH_DOMAIN', 'iwosan.health');

    const secret = this.configService.get<string>('STELLAR_WEB_AUTH_SECRET');
    if (secret) {
      this.serverKeypair = StellarSdk.Keypair.fromSecret(secret);
    } else {
      // Ephemeral server key keeps local development and tests working. In
      // production a stable key must be configured, otherwise challenges from
      // a previous process cannot be verified after a restart.
      this.serverKeypair = StellarSdk.Keypair.random();
      this.logger.warn(
        'STELLAR_WEB_AUTH_SECRET is not set; using an ephemeral SEP-10 signing key. ' +
          'Challenges will not survive a process restart.',
      );
    }
  }

  /** Build a SEP-10 challenge transaction for the given wallet account. */
  createChallenge(account: string): StellarChallengeResponse {
    this.assertValidAccount(account);

    const transaction = StellarSdk.WebAuth.buildChallengeTx(
      this.serverKeypair,
      account,
      this.homeDomain,
      CHALLENGE_TIMEOUT_SECONDS,
      this.networkPassphrase,
      this.homeDomain,
    );

    return {
      transaction,
      network_passphrase: this.networkPassphrase,
    };
  }

  /**
   * Verify the signed SEP-10 challenge, then issue the same JWT pair as a
   * password login. The Stellar account is linked to an existing user when one
   * already carries this public key, and a patient account is created
   * otherwise.
   */
  async authenticate(
    dto: StellarTokenDto,
    ipAddress: string,
    userAgent: string,
  ): Promise<AuthResponse> {
    this.assertValidAccount(dto.account);

    let challenge: { tx: StellarSdk.Transaction; clientAccountID: string };
    try {
      challenge = StellarSdk.WebAuth.readChallengeTx(
        dto.transaction,
        this.serverKeypair.publicKey(),
        this.networkPassphrase,
        this.homeDomain,
        this.homeDomain,
      );

      StellarSdk.WebAuth.verifyChallengeTxSigners(
        dto.transaction,
        this.serverKeypair.publicKey(),
        this.networkPassphrase,
        [dto.account],
        this.homeDomain,
        this.homeDomain,
      );
    } catch (error: unknown) {
      throw new UnauthorizedException(
        `Invalid Stellar challenge: ${describeError(error) || 'verification failed'}`,
      );
    }

    if (challenge.clientAccountID !== dto.account) {
      throw new UnauthorizedException('Challenge was issued for a different account');
    }

    this.assertNotReplayed(challenge.tx);

    const user = await this.findOrCreateUser(dto.account);
    if (!user.isActive) {
      throw new UnauthorizedException('User account is inactive');
    }

    const sessionId = randomBytes(32).toString('hex');
    const accessTokenExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const refreshTokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const tokens = this.authTokenService.generateTokenPair(user, sessionId, !user.mfaEnabled);

    await this.sessionManagementService.createSession(
      user.id,
      tokens.accessToken,
      tokens.refreshToken,
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
      ipAddress,
      userAgent,
    );
    await this.refreshTokenStore.store(sessionId, tokens.refreshToken);

    user.lastLoginAt = new Date();
    user.failedLoginAttempts = 0;
    await this.userRepository.save(user);

    return {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        mfaEnabled: user.mfaEnabled,
      },
      tokens: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
      },
    };
  }

  private async findOrCreateUser(account: string): Promise<User> {
    const existing = await this.userRepository
      .createQueryBuilder('user')
      .addSelect('user.stellarPublicKey')
      .where('user.stellarPublicKey = :account', { account })
      .getOne();

    if (existing) {
      return existing;
    }

    // Wallet-only users have no password; store a random, unusable hash so the
    // password login path can never succeed for this account.
    const passwordHash = await this.passwordValidationService.hashPassword(
      randomBytes(32).toString('hex'),
    );

    const user = this.userRepository.create({
      email: `stellar-${account.toLowerCase()}@stellar.iwosan.local`,
      passwordHash,
      firstName: 'Stellar',
      lastName: 'Wallet',
      role: UserRole.PATIENT,
      isActive: true,
      mfaEnabled: false,
      requiresPasswordChange: false,
      lastPasswordChangeAt: new Date(),
      stellarPublicKey: account,
    });

    return this.userRepository.save(user);
  }

  private assertNotReplayed(tx: StellarSdk.Transaction): void {
    const now = Date.now();
    for (const [hash, expiresAt] of this.usedChallenges) {
      if (expiresAt <= now) {
        this.usedChallenges.delete(hash);
      }
    }

    const hash = tx.hash().toString('hex');
    if (this.usedChallenges.has(hash)) {
      throw new UnauthorizedException('Challenge has already been used');
    }

    const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
    this.usedChallenges.set(
      hash,
      maxTime > 0 ? maxTime * 1000 : now + CHALLENGE_TIMEOUT_SECONDS * 1000,
    );
  }

  private assertValidAccount(account: string): void {
    try {
      StellarSdk.Keypair.fromPublicKey(account);
    } catch {
      throw new BadRequestException('account must be a Stellar public key (G...)');
    }
  }

  private resolveNetworkPassphrase(): string {
    const configured = this.configService.get<string>('STELLAR_NETWORK_PASSPHRASE');
    if (configured) {
      return configured;
    }
    return this.configService.get<string>('STELLAR_NETWORK', 'testnet') === 'mainnet'
      ? StellarSdk.Networks.PUBLIC
      : StellarSdk.Networks.TESTNET;
  }
}
