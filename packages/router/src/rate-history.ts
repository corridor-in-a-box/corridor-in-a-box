// Rate history collection, network isolation, and outlier sample detection (#602, #702).
//
// Design reference: RFC 0004 (docs/rfcs/0004-smart-router.md).
// A single bad sample (e.g. an anchor returning an anomalous price spike or bad quote)
// can severely distort percentiles like P25 or median rate estimates.
// Outlier samples are flagged and excluded from estimation percentiles (e.g. P25)
// while remaining visible in historical logs and audits (never silently deleted).

export type RateNetwork = "public" | "testnet";
export type RateSource = "sep38_price" | "sep38_quote" | "external";

export interface RateSample {
  readonly id?: string;
  readonly pair: string; // e.g. "USDC:iso4217:NGN"
  readonly rate: string; // decimal string or number
  readonly source: RateSource;
  readonly network: RateNetwork;
  readonly sampledAt: number; // epoch ms
  readonly anchorDomain: string;
  /** Whether this sample has been flagged as an anomalous price outlier. */
  readonly outlier?: boolean;
  /** Human-readable explanation of why this sample was flagged as an outlier. */
  readonly outlierReason?: string;
}

export interface OutlierOptions {
  /**
   * Relative deviation threshold from recent median to consider a sample an outlier.
   * Default is 0.10 (10%).
   */
  readonly threshold?: number;
  /**
   * Maximum number of recent non-outlier samples to consider when computing the baseline median.
   * Defaults to 50 samples.
   */
  readonly windowSize?: number;
}

export const DEFAULT_OUTLIER_THRESHOLD = 0.1; // 10% default threshold
export const DEFAULT_OUTLIER_WINDOW_SIZE = 50;

/**
 * Calculates the numeric median of an array of numbers.
 */
export function calculateMedian(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Checks whether a given rate deviates beyond the threshold from a baseline median.
 */
export function isRateOutlier(
  rate: number | string,
  baselineMedian: number | string,
  threshold: number = DEFAULT_OUTLIER_THRESHOLD,
): boolean {
  const r = typeof rate === "string" ? parseFloat(rate) : rate;
  const m = typeof baselineMedian === "string" ? parseFloat(baselineMedian) : baselineMedian;
  if (!Number.isFinite(r) || !Number.isFinite(m) || m <= 0) {
    return false;
  }
  const relativeDeviation = Math.abs(r - m) / m;
  return relativeDeviation > threshold;
}

/**
 * Computes a percentile (0.0 to 1.0) for a set of rate samples.
 * By default, samples flagged with outlier=true are excluded from the calculation.
 */
export function computePercentile(
  samples: readonly RateSample[],
  percentile: number, // 0 to 1, e.g. 0.25 for P25
  options?: { readonly excludeOutliers?: boolean },
): string | undefined {
  const excludeOutliers = options?.excludeOutliers ?? true;
  const filtered = excludeOutliers ? samples.filter((s) => !s.outlier) : samples;

  if (filtered.length === 0) return undefined;
  const nums = filtered
    .map((s) => parseFloat(s.rate))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  if (nums.length === 0) return undefined;
  if (nums.length === 1) return nums[0]!.toFixed(7);

  const clampedP = Math.max(0, Math.min(1, percentile));
  const rank = clampedP * (nums.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const weight = rank - lower;

  const result = nums[lower]! + weight * (nums[upper]! - nums[lower]!);
  return result.toFixed(7);
}

/**
 * Convenience helper to compute P25 (25th percentile) on samples, excluding outliers by default.
 */
export function computeP25(
  samples: readonly RateSample[],
  options?: { readonly excludeOutliers?: boolean },
): string | undefined {
  return computePercentile(samples, 0.25, options);
}

/**
 * Flags outlier samples across a chronological list of samples against a rolling median.
 */
export function flagOutliers(
  samples: readonly RateSample[],
  options?: OutlierOptions,
): RateSample[] {
  const threshold = options?.threshold ?? DEFAULT_OUTLIER_THRESHOLD;
  const windowSize = options?.windowSize ?? DEFAULT_OUTLIER_WINDOW_SIZE;

  const results: RateSample[] = [];
  const validHistory: number[] = [];

  for (const sample of samples) {
    const rateNum = parseFloat(sample.rate);
    if (!Number.isFinite(rateNum)) {
      results.push(sample);
      continue;
    }

    // Need at least 2 historical samples to establish a meaningful median baseline
    if (validHistory.length >= 2) {
      const recentWindow = validHistory.slice(-windowSize);
      const median = calculateMedian(recentWindow)!;
      const deviation = Math.abs(rateNum - median) / median;

      if (deviation > threshold) {
        results.push({
          ...sample,
          outlier: true,
          outlierReason: `Deviation of ${(deviation * 100).toFixed(2)}% from recent median ${median.toFixed(7)} exceeds threshold ${(threshold * 100).toFixed(0)}%`,
        });
        // Do not add outlier to validHistory so subsequent samples compare against clean median
        continue;
      }
    }

    validHistory.push(rateNum);
    results.push({
      ...sample,
      outlier: false,
    });
  }

  return results;
}

export interface DailyRateSummary {
  readonly network: RateNetwork;
  readonly pair: string;
  readonly date: string; // YYYY-MM-DD
  readonly count: number; // total samples count (including outliers)
  readonly validCount: number; // count of non-outlier samples
  readonly outlierCount: number; // count of flagged outlier samples
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly p25: string;
  readonly p50: string; // median
  readonly p90: string;
  readonly p99: string;
}

/**
 * Formats epoch ms into UTC YYYY-MM-DD date string.
 */
export function formatUtcDate(epochMs: number): string {
  const d = new Date(epochMs);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Asserts that all samples belong strictly to the expected network.
 */
export function assertNetworkIsolation(
  samples: readonly RateSample[],
  expectedNetwork: RateNetwork,
): void {
  for (const sample of samples) {
    if (sample.network !== expectedNetwork) {
      throw new Error(
        `Network isolation violation: expected all samples to have network="${expectedNetwork}", ` +
          `but found sample with network="${sample.network}" (anchor: ${sample.anchorDomain}, pair: ${sample.pair})`,
      );
    }
  }
}

/**
 * Aggregates samples into a daily summary for a specific network, pair, and date.
 * Flagged outlier samples are excluded from statistical percentiles (P25, P50, P90, P99, high, low)
 * but counted in total count and outlierCount.
 */
export function computeDailySummary(
  samples: readonly RateSample[],
  network: RateNetwork,
  pair: string,
  date: string, // YYYY-MM-DD
): DailyRateSummary | undefined {
  assertNetworkIsolation(samples, network);

  const matched = samples.filter((s) => {
    return s.network === network && s.pair === pair && formatUtcDate(s.sampledAt) === date;
  });

  if (matched.length === 0) {
    return undefined;
  }

  // Sort chronologically by sampledAt
  const chronological = [...matched].sort((a, b) => a.sampledAt - b.sampledAt);
  const open = chronological[0]!.rate;
  const close = chronological[chronological.length - 1]!.rate;

  const validSamples = matched.filter((s) => !s.outlier);
  const outlierCount = matched.length - validSamples.length;

  // Use valid samples for range and percentiles, fallback to matched if all are outliers
  const statSamples = validSamples.length > 0 ? validSamples : matched;
  const statNums = statSamples.map((s) => parseFloat(s.rate)).filter(Number.isFinite);

  const minVal = Math.min(...statNums).toFixed(7);
  const maxVal = Math.max(...statNums).toFixed(7);

  const p25 = computePercentile(statSamples, 0.25)!;
  const p50 = computePercentile(statSamples, 0.5)!;
  const p90 = computePercentile(statSamples, 0.9)!;
  const p99 = computePercentile(statSamples, 0.99)!;

  return {
    network,
    pair,
    date,
    count: matched.length,
    validCount: validSamples.length,
    outlierCount,
    open: parseFloat(open).toFixed(7),
    high: maxVal,
    low: minVal,
    close: parseFloat(close).toFixed(7),
    p25,
    p50,
    p90,
    p99,
  };
}

/**
 * In-memory collector for indicative and firm rate samples.
 * Supports automatic outlier detection against a configurable threshold.
 */
export class RateSampleCollector {
  private readonly samples: RateSample[] = [];

  constructor(private readonly defaultOptions?: OutlierOptions) {}

  /**
   * Records a new rate sample, automatically checking against recent median to flag outliers.
   */
  recordSample(sample: RateSample, options?: OutlierOptions): RateSample {
    const threshold =
      options?.threshold ?? this.defaultOptions?.threshold ?? DEFAULT_OUTLIER_THRESHOLD;
    const windowSize =
      options?.windowSize ?? this.defaultOptions?.windowSize ?? DEFAULT_OUTLIER_WINDOW_SIZE;

    const rateNum = parseFloat(sample.rate);
    if (!Number.isFinite(rateNum)) {
      this.samples.push(sample);
      return sample;
    }

    // Look up recent non-outlier samples for the same network, pair, and anchor
    const recentClean = this.samples
      .filter((s) => s.network === sample.network && s.pair === sample.pair && !s.outlier)
      .slice(-windowSize)
      .map((s) => parseFloat(s.rate))
      .filter(Number.isFinite);

    let processedSample: RateSample = sample;

    if (recentClean.length >= 2) {
      const median = calculateMedian(recentClean)!;
      const deviation = Math.abs(rateNum - median) / median;

      if (deviation > threshold) {
        processedSample = {
          ...sample,
          outlier: true,
          outlierReason: `Deviation of ${(deviation * 100).toFixed(2)}% from recent median ${median.toFixed(7)} exceeds threshold ${(threshold * 100).toFixed(0)}%`,
        };
      } else {
        processedSample = {
          ...sample,
          outlier: false,
        };
      }
    }

    this.samples.push(processedSample);
    return processedSample;
  }

  /**
   * Records a batch of samples.
   */
  recordBatch(samples: readonly RateSample[], options?: OutlierOptions): RateSample[] {
    return samples.map((s) => this.recordSample(s, options));
  }

  /**
   * Retrieves stored samples, optionally filtered by network and/or exclusion of outliers.
   */
  getSamples(
    network?: RateNetwork,
    options?: { readonly excludeOutliers?: boolean },
  ): RateSample[] {
    let result = network
      ? this.samples.filter((s) => s.network === network)
      : [...this.samples];
    if (options?.excludeOutliers) {
      result = result.filter((s) => !s.outlier);
    }
    return result;
  }

  /**
   * Retrieves only the samples flagged as outliers.
   */
  getOutliers(network?: RateNetwork): RateSample[] {
    return this.samples.filter((s) => (network ? s.network === network : true) && s.outlier);
  }

  /**
   * Clears all recorded samples.
   */
  clear(): void {
    this.samples.length = 0;
  }
}
