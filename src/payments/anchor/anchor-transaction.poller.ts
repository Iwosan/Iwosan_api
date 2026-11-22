import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { describeError } from '../../common/utils/describe-error.util';
import { AnchorService, ANCHOR_POLL_INTERVAL_MS } from './anchor.service';

/**
 * Refreshes pending SEP-24 transactions from the anchor every 30 seconds and
 * persists any status change. A lock flag prevents overlapping runs when a
 * poll takes longer than the interval.
 */
@Injectable()
export class AnchorTransactionPoller {
  private readonly logger = new Logger(AnchorTransactionPoller.name);
  private running = false;

  constructor(private readonly anchorService: AnchorService) {}

  @Interval(ANCHOR_POLL_INTERVAL_MS)
  async poll(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      const updated = await this.anchorService.refreshPendingTransactions();
      if (updated > 0) {
        this.logger.log(`Updated ${updated} anchor transaction(s)`);
      }
    } catch (error: unknown) {
      this.logger.warn(`Anchor status poll failed: ${describeError(error)}`);
    } finally {
      this.running = false;
    }
  }
}
