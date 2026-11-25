import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as QRCode from 'qrcode';
import { DrugBatchContractReader } from './drug-batch-contract.reader';
import { BatchStatus, DrugBatchVerificationDto } from './dto/drug-batch.dto';

const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 1_000;

interface CacheEntry {
  value: DrugBatchVerificationDto;
  expiresAt: number;
}

/**
 * Public verification of drug batches registered in the `drug-batch-registry`
 * contract: anyone can scan the QR code on a pack and see who made it, who has
 * held it, and whether it is expired or recalled.
 */
@Injectable()
export class DrugBatchesService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly webAppUrl: string;

  constructor(
    private readonly reader: DrugBatchContractReader,
    config: ConfigService,
  ) {
    this.webAppUrl = config.get<string>('WEB_APP_URL', 'http://localhost:3000').replace(/\/+$/, '');
  }

  async verify(batchId: string): Promise<DrugBatchVerificationDto> {
    const id = batchId.toLowerCase();
    const cached = this.cache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const batch = await this.reader.getBatch(id);
    if (!batch) {
      throw new NotFoundException('No drug batch is registered with this id');
    }
    const history = await this.reader.getHistory(id);

    const expired = batch.expiry * 1000 <= Date.now();
    const status: BatchStatus = batch.recalled ? 'recalled' : expired ? 'expired' : 'valid';
    const value: DrugBatchVerificationDto = {
      batchId: id,
      product: batch.product,
      kind: batch.kind,
      regulatoryNumber: batch.regulatoryNumber,
      manufacturer: batch.manufacturer,
      holder: batch.holder,
      expiresAt: new Date(batch.expiry * 1000).toISOString(),
      expired,
      recalled: batch.recalled,
      status,
      history: history.map((step) => ({
        from: step.from,
        to: step.to,
        at: new Date(step.at * 1000).toISOString(),
      })),
      verifyUrl: this.verifyUrl(id),
    };

    this.remember(id, value);
    return value;
  }

  /** PNG QR code linking to the web verification page for the batch. */
  async qrCode(batchId: string): Promise<Buffer> {
    return QRCode.toBuffer(this.verifyUrl(batchId.toLowerCase()), {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 512,
    });
  }

  /** Drop a cached result, e.g. when a recall event arrives. */
  forget(batchId: string): void {
    this.cache.delete(batchId.toLowerCase());
  }

  private verifyUrl(batchId: string): string {
    return `${this.webAppUrl}/verify/${batchId}`;
  }

  private remember(batchId: string, value: DrugBatchVerificationDto): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      // Maps iterate in insertion order, so the first key is the oldest entry.
      for (const oldest of this.cache.keys()) {
        this.cache.delete(oldest);
        break;
      }
    }
    this.cache.set(batchId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
}
