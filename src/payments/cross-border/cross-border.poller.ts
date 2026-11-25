import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { describeError } from '../../common/utils/describe-error.util';
import { CrossBorderService } from './cross-border.service';

export const CROSS_BORDER_POLL_INTERVAL_MS = 30_000;

/** Keeps cross-border payments in sync with the anchor until they finish. */
@Injectable()
export class CrossBorderPaymentPoller {
  private readonly logger = new Logger(CrossBorderPaymentPoller.name);

  constructor(private readonly crossBorderService: CrossBorderService) {}

  @Interval(CROSS_BORDER_POLL_INTERVAL_MS)
  async refresh(): Promise<void> {
    try {
      const updated = await this.crossBorderService.refreshPendingPayments();
      if (updated > 0) {
        this.logger.log(`Updated ${updated} cross-border payment(s)`);
      }
    } catch (error: unknown) {
      this.logger.warn(`Cross-border payment refresh failed: ${describeError(error)}`);
    }
  }
}
