import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { firstValueFrom } from 'rxjs';
import { describeError } from '../../common/utils/describe-error.util';
import { MarketplaceOrdersService } from '../../marketplace/marketplace-orders.service';
import { CreateCrossBorderPaymentDto, CrossBorderPartyDto } from './dto/cross-border.dto';
import {
  CROSS_BORDER_TERMINAL_STATUSES,
  CrossBorderPayment,
} from './entities/cross-border-payment.entity';

export const CROSS_BORDER_POLL_BATCH_SIZE = 50;
const TOML_CACHE_TTL_MS = 5 * 60_000;

interface AnchorCustomerPayload {
  id?: string;
  message?: string;
}

interface AnchorTransactionPayload {
  id?: string;
  status?: string;
  message?: string;
  transaction?: { id?: string; status?: string; message?: string };
}

export interface CrossBorderPaymentView {
  id: string;
  orderId: string | null;
  campaignId: string | null;
  status: string;
  message: string | null;
  amount: string;
  assetCode: string;
  anchorTransactionId: string | null;
  senderCustomerId: string;
  receiverCustomerId: string;
  orderPaymentStatus?: string;
  createdAt: Date;
}

/**
 * SEP-31 direct payments for diaspora-funded orders.
 *
 * The sender and receiver are registered as SEP-12 customers with the anchor;
 * the anchor then moves money from the sender's wallet to the receiver's
 * Nigerian account (or wallet). The API polls the anchor until the payment
 * completes, then marks the marketplace order as paid.
 */
@Injectable()
export class CrossBorderService {
  private readonly logger = new Logger(CrossBorderService.name);
  private readonly homeDomain: string;
  private readonly defaultAssetCode: string;
  private readonly tomlCache = new Map<string, { servers: AnchorServers; expiresAt: number }>();

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
    @InjectRepository(CrossBorderPayment)
    private readonly payments: Repository<CrossBorderPayment>,
    private readonly orders: MarketplaceOrdersService,
  ) {
    this.homeDomain = this.config.get<string>('ANCHOR_HOME_DOMAIN', 'testanchor.stellar.org');
    this.defaultAssetCode = this.config.get<string>('ANCHOR_ASSET_CODE', 'USDC');
  }

  async initiate(
    dto: CreateCrossBorderPaymentDto,
    userId: string,
  ): Promise<CrossBorderPaymentView> {
    if (!dto.orderId && !dto.campaignId) {
      throw new BadRequestException('Provide either orderId or campaignId');
    }
    if (dto.orderId && dto.campaignId) {
      throw new BadRequestException('Provide only one of orderId or campaignId');
    }
    if (dto.sender.customerId && dto.receiver.customerId === dto.sender.customerId) {
      throw new BadRequestException('Sender and receiver must be different customers');
    }

    const servers = await this.resolveServers(this.homeDomain);
    const authToken = dto.authToken;

    const senderCustomerId =
      dto.sender.customerId ??
      (await this.registerCustomer(servers.kycServer, dto.sender, authToken));
    const receiverCustomerId =
      dto.receiver.customerId ??
      (await this.registerCustomer(servers.kycServer, dto.receiver, authToken));

    const assetCode = dto.assetCode ?? this.defaultAssetCode;
    const body = {
      amount: dto.amount,
      asset_code: assetCode,
      sender_id: senderCustomerId,
      receiver_id: receiverCustomerId,
      // Helps the anchor reconcile the payment with the Iwosan order.
      external_id: dto.orderId ?? dto.campaignId,
    };

    let payload: AnchorTransactionPayload;
    try {
      const response = await firstValueFrom(
        this.http.post<AnchorTransactionPayload>(
          `${servers.directPaymentServer}/transactions`,
          JSON.stringify(body),
          { headers: this.jsonHeaders(authToken) },
        ),
      );
      payload = response.data ?? {};
    } catch (error: unknown) {
      this.logger.warn(`SEP-31 transaction failed at ${this.homeDomain}: ${describeError(error)}`);
      throw new BadGatewayException(
        'The anchor did not accept the cross-border payment. Check the customer details and amount.',
      );
    }

    const saved = await this.payments.save(
      this.payments.create({
        userId,
        orderId: dto.orderId ?? null,
        campaignId: dto.campaignId ?? null,
        senderCustomerId,
        receiverCustomerId,
        receiverAccount: dto.receiver.account,
        amount: dto.amount,
        assetCode,
        anchorTransactionId: payload.id ?? null,
        status: payload.status ?? 'pending',
        anchorHomeDomain: this.homeDomain,
        message: payload.message ?? null,
        authToken: authToken ?? null,
        rawResponse: { ...payload },
      }),
    );

    return this.toView(saved);
  }

  /** Poll every non-terminal payment and persist the anchor's latest status. */
  async refreshPendingPayments(): Promise<number> {
    const pending = await this.payments.find({
      where: { status: Not(In(CROSS_BORDER_TERMINAL_STATUSES)) },
      order: { createdAt: 'ASC' },
      take: CROSS_BORDER_POLL_BATCH_SIZE,
    });

    let updated = 0;
    for (const payment of pending) {
      if (!payment.anchorTransactionId) {
        continue;
      }
      try {
        const servers = await this.resolveServers(payment.anchorHomeDomain);
        const response = await firstValueFrom(
          this.http.get<AnchorTransactionPayload>(
            `${servers.directPaymentServer}/transactions/${encodeURIComponent(
              payment.anchorTransactionId,
            )}`,
            {
              ...(payment.authToken
                ? { headers: { Authorization: `Bearer ${payment.authToken}` } }
                : {}),
            },
          ),
        );

        const details = response.data?.transaction ?? response.data ?? {};
        const status = details.status;
        if (!status || status === payment.status) {
          continue;
        }

        payment.status = status;
        payment.message = details.message ?? null;
        payment.rawResponse = { ...(response.data ?? {}) };
        await this.payments.save(payment);
        updated += 1;

        if (status === 'completed' && payment.orderId) {
          await this.orders.markPaid(payment.orderId, payment.anchorTransactionId ?? undefined);
        }
      } catch (error: unknown) {
        this.logger.warn(
          `Unable to refresh cross-border payment ${payment.id}: ${describeError(error)}`,
        );
      }
    }

    return updated;
  }

  async findOne(id: string, userId: string): Promise<CrossBorderPaymentView> {
    const payment = await this.payments.findOne({ where: { id } });
    if (!payment || payment.userId !== userId) {
      throw new NotFoundException('Cross-border payment not found');
    }
    return this.toView(payment);
  }

  /** SEP-12 `PUT /customer`, returning the anchor's customer id. */
  private async registerCustomer(
    kycServer: string,
    party: CrossBorderPartyDto,
    authToken?: string,
  ): Promise<string> {
    const body: Record<string, string> = { account: party.account };
    if (party.firstName) body.first_name = party.firstName;
    if (party.lastName) body.last_name = party.lastName;
    if (party.email) body.email = party.email;

    try {
      const response = await firstValueFrom(
        this.http.put<AnchorCustomerPayload>(`${kycServer}/customer`, JSON.stringify(body), {
          headers: this.jsonHeaders(authToken),
        }),
      );
      const id = response.data?.id;
      if (!id) {
        throw new BadGatewayException('Anchor did not return a customer id');
      }
      return id;
    } catch (error: unknown) {
      if (error instanceof BadGatewayException) {
        throw error;
      }
      this.logger.warn(`SEP-12 customer registration failed: ${describeError(error)}`);
      throw new BadGatewayException(
        'The anchor rejected the customer details. Check the KYC fields and try again.',
      );
    }
  }

  /** SEP-31 requires the anchor's DIRECT_PAYMENT_SERVER; SEP-12 uses KYC_SERVER. */
  private async resolveServers(homeDomain: string): Promise<AnchorServers> {
    const cached = this.tomlCache.get(homeDomain);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.servers;
    }

    const tomlUrl = `https://${homeDomain}/.well-known/stellar.toml`;
    let toml: string;
    try {
      const response = await firstValueFrom(this.http.get(tomlUrl, { responseType: 'text' }));
      toml = typeof response.data === 'string' ? response.data : String(response.data);
    } catch (error: unknown) {
      this.logger.warn(`Unable to load ${tomlUrl}: ${describeError(error)}`);
      throw new BadGatewayException(`Unable to load the anchor stellar.toml from ${homeDomain}`);
    }

    const directPaymentServer = this.readTomlValue(toml, 'DIRECT_PAYMENT_SERVER');
    if (!directPaymentServer) {
      throw new BadGatewayException(
        `Anchor ${homeDomain} does not advertise a SEP-31 DIRECT_PAYMENT_SERVER`,
      );
    }
    const kycServer = this.readTomlValue(toml, 'KYC_SERVER') ?? directPaymentServer;

    const servers: AnchorServers = {
      directPaymentServer: directPaymentServer.replace(/\/$/, ''),
      kycServer: kycServer.replace(/\/$/, ''),
    };
    this.tomlCache.set(homeDomain, { servers, expiresAt: Date.now() + TOML_CACHE_TTL_MS });
    return servers;
  }

  private jsonHeaders(authToken?: string): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }
    return headers;
  }

  private readTomlValue(toml: string, key: string): string | null {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm').exec(toml);
    return match?.[1] ?? null;
  }

  private toView(payment: CrossBorderPayment): CrossBorderPaymentView {
    return {
      id: payment.id,
      orderId: payment.orderId,
      campaignId: payment.campaignId,
      status: payment.status,
      message: payment.message,
      amount: payment.amount,
      assetCode: payment.assetCode,
      anchorTransactionId: payment.anchorTransactionId,
      senderCustomerId: payment.senderCustomerId,
      receiverCustomerId: payment.receiverCustomerId,
      createdAt: payment.createdAt,
    };
  }
}

interface AnchorServers {
  directPaymentServer: string;
  kycServer: string;
}
