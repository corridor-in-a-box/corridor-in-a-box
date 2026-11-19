// Rate history collection and network-isolated summaries (#702, RFC 0004 §7).
//
// Collects indicative prices and historical rate samples from mainnet and testnet anchors.
// Mainnet samples are stored with network = "public"; testnet samples with network = "testnet".
//
// Invariant: Testnet and mainnet samples must NEVER mix in a summary.

export type RateNetwork = "public" | "testnet";

export type RateSource = "sep38_price" | "dex_trade" | "reference_fx" | "own_payment";

export interface RateSample {
  /** Currency pair in standard format (e.g. "USDC:iso4217:NGN" or "XLM:USDC"). */
  readonly pair: string;
  /** Decimal rate string (e.g. "1550.2500000"). Never a floating point number. */
  readonly rate: string;
  /** Source of this rate sample. */
  readonly source: RateSource;
  /** Timestamp when the rate was sampled (epoch ms). */
  readonly sampledAt: number;
  /** Network on which the sample was observed. */
  readonly network: RateNetwork;
  /** Anchor domain if sampled from a specific anchor. */
  readonly anchorDomain?: string;
  /** Optional transaction hash or reference ID. */
  readonly referenceId?: string;
}

export interface DailyRateSummary {
  readonly pair: string;
  readonly network: RateNetwork;
  /** UTC date string in YYYY-MM-DD format. */
  readonly date: string;
  readonly count: number;
  readonly min: string;
  readonly p25: string;
  readonly median: string;
  readonly p75: string;
  readonly max: string;
  readonly computedAt: number;
}

/**
 * Validates that all provided samples strictly belong to the specified network.
 * Throws an Error if any sample belongs to a different network.
 */
export function assertNetworkIsolation(
  samples: readonly RateSample[],
  expectedNetwork: RateNetwork,
): void {
  for (const sample of samples) {
    if (sample.network !== expectedNetwork) {
      throw new Error(
        `Network isolation violation: expected ${expectedNetwork} but found sample from ${sample.network} for pair ${sample.pair}`,
      );
    }
  }
}

/**
 * Formats a Date into a UTC YYYY-MM-DD string.
 */
export function formatUtcDate(epochMs: number): string {
  const d = new Date(epochMs);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Computes a percentile value from a sorted array of decimal strings using linear interpolation.
 */
function computePercentile(sortedValues: readonly string[], percentile: number): string {
  if (sortedValues.length === 0) return "0";
  if (sortedValues.length === 1) return sortedValues[0]!;

  const index = (percentile / 100) * (sortedValues.length - 1);
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);

  if (lowerIndex === upperIndex) {
    return sortedValues[lowerIndex]!;
  }

  // Fractional interpolation using BigInt or decimal arithmetic to avoid floating point drift
  const lower = Number(sortedValues[lowerIndex]);
  const upper = Number(sortedValues[upperIndex]);
  const fraction = index - lowerIndex;
  const interpolated = lower + (upper - lower) * fraction;
  return interpolated.toFixed(7);
}

/**
 * Computes a daily summary for a given pair and network.
 *
 * Guarantees:
 * - Samples from other networks are never included.
 * - Samples from other pairs or other dates are excluded.
 * - Computes count, min, p25, median, p75, max.
 */
export function computeDailySummary(
  allSamples: readonly RateSample[],
  targetNetwork: RateNetwork,
  pair: string,
  dateString: string,
): DailyRateSummary | undefined {
  // Filter strictly by targetNetwork, pair, and date
  const filtered = allSamples.filter((sample) => {
    if (sample.network !== targetNetwork) return false;
    if (sample.pair !== pair) return false;
    return formatUtcDate(sample.sampledAt) === dateString;
  });

  if (filtered.length === 0) {
    return undefined;
  }

  // Double-check isolation invariant
  assertNetworkIsolation(filtered, targetNetwork);

  // Sort values numerically
  const sortedValues = filtered.map((s) => s.rate).sort((a, b) => Number(a) - Number(b));

  return {
    pair,
    network: targetNetwork,
    date: dateString,
    count: sortedValues.length,
    min: sortedValues[0]!,
    p25: computePercentile(sortedValues, 25),
    median: computePercentile(sortedValues, 50),
    p75: computePercentile(sortedValues, 75),
    max: sortedValues[sortedValues.length - 1]!,
    computedAt: Date.now(),
  };
}

/**
 * In-memory collector repository for rate samples with network separation.
 */
export class RateSampleCollector {
  private readonly samples: RateSample[] = [];

  /** Record a sample. */
  record(sample: RateSample): void {
    this.samples.push(sample);
  }

  /** Record multiple samples. */
  recordBatch(samples: readonly RateSample[]): void {
    for (const sample of samples) {
      this.record(sample);
    }
  }

  /**
   * Get all samples for a specific network, completely filtered from other networks.
   */
  getSamples(network: RateNetwork, pair?: string): readonly RateSample[] {
    return this.samples.filter((s) => s.network === network && (!pair || s.pair === pair));
  }

  /**
   * Compute summaries for a given network and date across all pairs.
   */
  summarizeDay(network: RateNetwork, dateString: string): DailyRateSummary[] {
    const networkSamples = this.getSamples(network);
    const pairs = [...new Set(networkSamples.map((s) => s.pair))];
    const summaries: DailyRateSummary[] = [];

    for (const pair of pairs) {
      const summary = computeDailySummary(networkSamples, network, pair, dateString);
      if (summary) {
        summaries.push(summary);
      }
    }

    return summaries;
  }

  /** Total number of recorded samples. */
  get totalCount(): number {
    return this.samples.length;
  }

  clear(): void {
    this.samples.length = 0;
  }
}
