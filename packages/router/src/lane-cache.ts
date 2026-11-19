// Lane check caching with 24-hour expiry and background refresh (#633).
//
// Running a lane check (SEP probe, liveness check, attestation check) before
// every single payment introduces unnecessary latency and places excessive load
// on destination anchors. This cache retains verified lane results per receiver
// domain for 24 hours, automatically refreshing expired entries in the background.

export interface LaneCheckResult {
  /** Whether the lane is currently open and runnable. */
  readonly runnable: boolean;
  /** Timestamp when the check was performed (epoch ms). */
  readonly checkedAt: number;
  /** Optional failure reason or status notes. */
  readonly reason?: string;
  /** The protocol verified (e.g. "sep31", "sep6"). */
  readonly protocol?: string;
  /** Additional diagnostic data. */
  readonly details?: Readonly<Record<string, unknown>>;
}

export type LaneCheckerFn = (receiverDomain: string) => Promise<LaneCheckResult>;

export interface LaneCacheOptions {
  /** Cache time-to-live in milliseconds. Defaults to 24 hours (86_400_000 ms). */
  readonly ttlMs?: number;
  /** Injectable clock returning current epoch ms. Defaults to Date.now. */
  readonly clock?: () => number;
  /** Optional callback invoked when a background refresh fails. */
  readonly onBackgroundError?: (domain: string, error: unknown) => void;
}

interface CacheEntry {
  readonly result: LaneCheckResult;
  readonly cachedAt: number;
  refreshingPromise?: Promise<LaneCheckResult>;
}

export const DEFAULT_LANE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class LaneCheckCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly clock: () => number;
  private readonly onBackgroundError?: (domain: string, error: unknown) => void;

  constructor(
    private readonly checker: LaneCheckerFn,
    options: LaneCacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_LANE_CACHE_TTL_MS;
    this.clock = options.clock ?? (() => Date.now());
    this.onBackgroundError = options.onBackgroundError;
  }

  /**
   * Check a receiver domain's lane status.
   * If cached and within TTL, returns immediately from cache.
   * If expired, returns the cached result while triggering a background re-check.
   * If not cached, performs an immediate check.
   */
  async check(receiverDomain: string): Promise<LaneCheckResult> {
    const domain = receiverDomain.toLowerCase();
    const entry = this.entries.get(domain);
    const now = this.clock();

    if (!entry) {
      return this.refresh(domain);
    }

    const age = now - entry.cachedAt;
    if (age < this.ttlMs) {
      return entry.result;
    }

    // Expired: trigger background refresh without blocking current caller
    this.triggerBackgroundRefresh(domain, entry);
    return entry.result;
  }

  /**
   * Forcibly re-check and refresh the cache for a domain.
   */
  async refresh(receiverDomain: string): Promise<LaneCheckResult> {
    const domain = receiverDomain.toLowerCase();
    const existing = this.entries.get(domain);

    if (existing?.refreshingPromise) {
      return existing.refreshingPromise;
    }

    const refreshPromise = (async () => {
      try {
        const result = await this.checker(domain);
        const cachedAt = this.clock();
        this.entries.set(domain, { result, cachedAt });
        return result;
      } finally {
        const current = this.entries.get(domain);
        if (current) {
          delete current.refreshingPromise;
        }
      }
    })();

    if (existing) {
      existing.refreshingPromise = refreshPromise;
    } else {
      this.entries.set(domain, {
        result: { runnable: false, checkedAt: this.clock(), reason: "initial fetch" },
        cachedAt: 0,
        refreshingPromise: refreshPromise,
      });
    }

    return refreshPromise;
  }

  private triggerBackgroundRefresh(domain: string, entry: CacheEntry): void {
    if (entry.refreshingPromise) return;

    entry.refreshingPromise = this.checker(domain)
      .then((newResult) => {
        this.entries.set(domain, { result: newResult, cachedAt: this.clock() });
        return newResult;
      })
      .catch((err) => {
        this.onBackgroundError?.(domain, err);
        return entry.result;
      })
      .finally(() => {
        const current = this.entries.get(domain);
        if (current) {
          delete current.refreshingPromise;
        }
      });
  }

  /** Retrieve the cached result synchronously, if any. */
  getCached(receiverDomain: string): LaneCheckResult | undefined {
    return this.entries.get(receiverDomain.toLowerCase())?.result;
  }

  /** Whether the cached entry is older than the configured TTL. */
  isExpired(receiverDomain: string): boolean {
    const entry = this.entries.get(receiverDomain.toLowerCase());
    if (!entry) return true;
    return this.clock() - entry.cachedAt >= this.ttlMs;
  }

  /** Clear all cached lane results. */
  clear(): void {
    this.entries.clear();
  }

  /** Number of domains currently cached. */
  get size(): number {
    return this.entries.size;
  }
}
