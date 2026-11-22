import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { firstValueFrom } from 'rxjs';
import { describeError } from '../../common/utils/describe-error.util';
import { AnchorInteractionDto } from './dto/anchor.dto';
import { AnchorDirection, AnchorTransaction } from './entities/anchor-transaction.entity';

export const ANCHOR_POLL_INTERVAL_MS = 30_000;
const TOML_CACHE_TTL_MS = 5 * 60_000;
const PENDING_BATCH_SIZE = 50;

/** SEP-24 statuses after which no further status updates are expected. */
const TERMINAL_STATUSES = [
  'completed',
  'refunded',
  'expired',
  'error',
  'no_market',
  'too_small',
  'too_large',
];

interface AnchorInteractivePayload {
  type?: string;
  url?: string;
  id?: string;
  message?: string;
}

interface AnchorStatusPayload {
  status?: string;
  message?: string;
  transaction?: { status?: string; message?: string };
}

export interface AnchorInteractionResult {
  id: string;
  direction: AnchorDirection;
  status: string;
  url: string;
  anchorTransactionId: string | null;
}

@Injectable()
export class AnchorService {
  private readonly logger = new Logger(AnchorService.name);
  private readonly homeDomain: string;
  private readonly defaultAssetCode: string;
  private transferServerCache?: { url: string; expiresAt: number };

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    @InjectRepository(AnchorTransaction)
    private readonly transactions: Repository<AnchorTransaction>,
  ) {
    this.homeDomain = this.configService.get<string>(
      'ANCHOR_HOME_DOMAIN',
      'testanchor.stellar.org',
    );
    this.defaultAssetCode = this.configService.get<string>('ANCHOR_ASSET_CODE', 'USDC');
  }

  startDeposit(dto: AnchorInteractionDto, userId: string): Promise<AnchorInteractionResult> {
    return this.startInteractive(AnchorDirection.DEPOSIT, dto, userId);
  }

  startWithdraw(dto: AnchorInteractionDto, userId: string): Promise<AnchorInteractionResult> {
    return this.startInteractive(AnchorDirection.WITHDRAW, dto, userId);
  }

  private async startInteractive(
    direction: AnchorDirection,
    dto: AnchorInteractionDto,
    userId: string,
  ): Promise<AnchorInteractionResult> {
    const transferServer = await this.getTransferServerUrl();

    const body: Record<string, string> = {
      asset_code: dto.assetCode || this.defaultAssetCode,
      account: dto.account,
    };
    if (dto.amount) {
      body.amount = dto.amount;
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (dto.authToken) {
      headers.Authorization = `Bearer ${dto.authToken}`;
    }

    let payload: AnchorInteractivePayload;
    try {
      const response = await firstValueFrom(
        this.httpService.post<AnchorInteractivePayload>(
          `${transferServer}/transactions/${direction}/interactive`,
          JSON.stringify(body),
          { headers },
        ),
      );
      payload = response.data;
    } catch (error: unknown) {
      this.logger.warn(`SEP-24 ${direction} failed at ${this.homeDomain}: ${describeError(error)}`);
      throw new BadGatewayException(
        `Anchor did not start the ${direction} flow. Check the asset code and account.`,
      );
    }

    if (!payload?.url) {
      throw new BadGatewayException('Anchor did not return an interactive URL');
    }

    const anchorTransactionId = this.extractAnchorTransactionId(payload);
    const transaction = this.transactions.create({
      userId,
      direction,
      account: dto.account,
      assetCode: dto.assetCode || this.defaultAssetCode,
      amount: dto.amount ?? null,
      anchorTransactionId,
      interactiveUrl: payload.url,
      status: 'incomplete',
      anchorHomeDomain: this.homeDomain,
      message: null,
      authToken: dto.authToken ?? null,
      rawResponse: { ...payload },
    });

    const saved = await this.transactions.save(transaction);

    return {
      id: saved.id,
      direction,
      status: saved.status,
      url: payload.url,
      anchorTransactionId,
    };
  }

  /**
   * Pull the latest status for every non-terminal transaction from the anchor
   * and persist it. Runs on an interval (see AnchorTransactionPoller) and can
   * be invoked directly by tests or operational tooling.
   */
  async refreshPendingTransactions(): Promise<number> {
    const pending = await this.transactions.find({
      where: { status: Not(In(TERMINAL_STATUSES)) },
      order: { createdAt: 'ASC' },
      take: PENDING_BATCH_SIZE,
    });

    let updated = 0;
    for (const transaction of pending) {
      if (!transaction.anchorTransactionId) {
        continue;
      }

      try {
        const transferServer = await this.getTransferServerUrl();
        const response = await firstValueFrom(
          this.httpService.get<AnchorStatusPayload>(`${transferServer}/transaction`, {
            params: { id: transaction.anchorTransactionId },
            ...(transaction.authToken
              ? { headers: { Authorization: `Bearer ${transaction.authToken}` } }
              : {}),
          }),
        );

        const payload = response.data ?? {};
        const details = payload.transaction ?? payload;
        const status: string | undefined = details.status;

        if (status && status !== transaction.status) {
          transaction.status = status;
          transaction.message = details.message ?? null;
          transaction.rawResponse = { ...payload };
          await this.transactions.save(transaction);
          updated += 1;
        }
      } catch (error: unknown) {
        this.logger.warn(
          `Unable to refresh anchor transaction ${transaction.anchorTransactionId}: ${describeError(
            error,
          )}`,
        );
      }
    }

    return updated;
  }

  /** Resolve the SEP-24 transfer server from the anchor's stellar.toml. */
  private async getTransferServerUrl(): Promise<string> {
    if (this.transferServerCache && this.transferServerCache.expiresAt > Date.now()) {
      return this.transferServerCache.url;
    }

    const tomlUrl = `https://${this.homeDomain}/.well-known/stellar.toml`;
    let toml: string;
    try {
      const response = await firstValueFrom(
        this.httpService.get(tomlUrl, { responseType: 'text' }),
      );
      toml = typeof response.data === 'string' ? response.data : String(response.data);
    } catch (error: unknown) {
      this.logger.warn(`Unable to load ${tomlUrl}: ${describeError(error)}`);
      throw new BadGatewayException(
        `Unable to load the anchor stellar.toml from ${this.homeDomain}`,
      );
    }

    const transferServer =
      this.readTomlValue(toml, 'TRANSFER_SERVER_SEP0024') ??
      this.readTomlValue(toml, 'TRANSFER_SERVER');

    if (!transferServer) {
      throw new BadGatewayException(
        `Anchor ${this.homeDomain} does not advertise a SEP-24 transfer server`,
      );
    }

    this.transferServerCache = {
      url: transferServer.replace(/\/$/, ''),
      expiresAt: Date.now() + TOML_CACHE_TTL_MS,
    };
    return this.transferServerCache.url;
  }

  /**
   * Anchors such as testanchor return no numeric id; the id is embedded in the
   * interactive URL as `transaction_id`.
   */
  private extractAnchorTransactionId(payload: AnchorInteractivePayload): string | null {
    if (payload.id) {
      return payload.id;
    }
    if (!payload.url) {
      return null;
    }
    try {
      const url = new URL(payload.url);
      return url.searchParams.get('transaction_id') ?? url.searchParams.get('id');
    } catch {
      return null;
    }
  }

  private readTomlValue(toml: string, key: string): string | null {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm').exec(toml);
    return match?.[1] ?? null;
  }
}
