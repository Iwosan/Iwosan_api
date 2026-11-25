/**
 * Simple in-process fixed-window limiter used for per-user abuse limits on
 * Stellar endpoints. `limit <= 0` disables limiting.
 */
export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** Returns `false` when `key` has used up its allowance for the window. */
  consume(key: string): boolean {
    if (this.limit <= 0) {
      return true;
    }

    const now = this.clock();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (bucket.count >= this.limit) {
      return false;
    }
    bucket.count += 1;
    return true;
  }

  reset(): void {
    this.buckets.clear();
  }
}
