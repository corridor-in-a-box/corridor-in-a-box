// Outlier flagging for rate history (RFC 0004 §3, issue #602).
//
// One bad sample (an anchor answering a single call with a wrong price) can drag a percentile.
// A sample whose rate is more than a threshold away from the median of the samples just before
// it, in the same series, is flagged as an outlier. It is stored with `outlier = true`, never
// deleted, and the estimate (P25) and the daily summaries leave it out.
//
// The baseline is the median of the last `windowSize` samples of the series, flagged ones
// included. A median ignores a lone spike, so a bad sample cannot move it much; and including
// flagged samples means a real, lasting move (a devaluation, say) stops being flagged once it
// makes up more than half the window, instead of every later sample being flagged forever.
//
// Rates stay decimal strings and the arithmetic is BigInt on scaled integers, so there is no
// float anywhere. The median of an even count is the exact midpoint (one extra decimal digit
// at most), and the threshold test `|rate - median| * 10000 > thresholdBps * median` is an
// exact integer comparison. Only the reported `deviationBps` is rounded (down, to whole bps).

/** Default threshold: 1,000 bps, i.e. a sample more than 10% from the recent median. */
export const DEFAULT_OUTLIER_THRESHOLD_BPS = 1_000;
/** Default baseline: the median of the 20 samples before this one (5 hours at 15 minutes). */
export const DEFAULT_OUTLIER_WINDOW = 20;
/** Below this many earlier samples there is no baseline, so nothing is flagged. */
export const DEFAULT_OUTLIER_MIN_BASELINE = 3;

export interface OutlierPolicy {
  /** How far from the recent median a rate may be before it is flagged, in basis points. */
  thresholdBps?: number;
  /** How many of the series' most recent earlier samples make up the baseline. */
  windowSize?: number;
  /** Fewest earlier samples needed before anything is flagged. */
  minBaselineSamples?: number;
}

export interface OutlierVerdict {
  outlier: boolean;
  /** Median of the baseline, as an exact decimal string; null when the baseline was too small. */
  median: string | null;
  /** |rate - median| / median in whole basis points, rounded down; null without a baseline. */
  deviationBps: number | null;
  /** How many earlier samples the baseline was taken from. */
  baselineSize: number;
}

interface Scaled {
  digits: bigint;
  scale: number;
}

const DECIMAL = /^\d+(?:\.\d+)?$/;

function parseRate(raw: string, field: string): Scaled {
  if (typeof raw !== "string" || !DECIMAL.test(raw) || !/[1-9]/.test(raw)) {
    throw new RangeError(
      `${field} must be a positive decimal string, got ${JSON.stringify(raw)}`,
    );
  }
  const [whole = "", frac = ""] = raw.split(".");
  return { digits: BigInt(whole + frac), scale: frac.length };
}

function rescale(v: Scaled, scale: number): bigint {
  return v.digits * 10n ** BigInt(scale - v.scale);
}

function compare(a: Scaled, b: Scaled): number {
  const scale = Math.max(a.scale, b.scale);
  const x = rescale(a, scale);
  const y = rescale(b, scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

function format(v: Scaled): string {
  if (v.scale === 0) return v.digits.toString();
  const s = v.digits.toString().padStart(v.scale + 1, "0");
  const whole = s.slice(0, -v.scale);
  const frac = s.slice(-v.scale).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

function medianOf(values: readonly Scaled[]): Scaled {
  const sorted = [...values].sort(compare);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  const a = sorted[mid - 1]!;
  const b = sorted[mid]!;
  const scale = Math.max(a.scale, b.scale);
  const sum = rescale(a, scale) + rescale(b, scale);
  // sum / 2 == sum * 5 / 10: exact with one more decimal digit.
  return sum % 2n === 0n
    ? { digits: sum / 2n, scale }
    : { digits: sum * 5n, scale: scale + 1 };
}

function resolvePolicy(policy: OutlierPolicy = {}): Required<OutlierPolicy> {
  const thresholdBps = policy.thresholdBps ?? DEFAULT_OUTLIER_THRESHOLD_BPS;
  if (!Number.isInteger(thresholdBps) || thresholdBps < 1) {
    throw new RangeError("thresholdBps must be a positive integer");
  }
  const minBaselineSamples = policy.minBaselineSamples ?? DEFAULT_OUTLIER_MIN_BASELINE;
  if (!Number.isInteger(minBaselineSamples) || minBaselineSamples < 1) {
    throw new RangeError("minBaselineSamples must be a positive integer");
  }
  const windowSize = policy.windowSize ?? DEFAULT_OUTLIER_WINDOW;
  if (!Number.isInteger(windowSize) || windowSize < minBaselineSamples) {
    throw new RangeError("windowSize must be an integer >= minBaselineSamples");
  }
  return { thresholdBps, windowSize, minBaselineSamples };
}

/** The exact median of positive decimal rate strings. Throws on an empty list or a bad rate. */
export function medianRate(rates: readonly string[]): string {
  if (rates.length === 0) throw new RangeError("median of no rates");
  return format(medianOf(rates.map((r, i) => parseRate(r, `rates[${i}]`))));
}

/**
 * Decide whether `rate` is an outlier against `recent`, the rates of the same series observed
 * before it (any order; only the last `windowSize` by position are used, so pass them oldest
 * first). Pure: stores nothing.
 */
export function checkOutlier(
  rate: string,
  recent: readonly string[],
  policy?: OutlierPolicy,
): OutlierVerdict {
  const { thresholdBps, windowSize, minBaselineSamples } = resolvePolicy(policy);
  const value = parseRate(rate, "rate");
  const window = recent.slice(-windowSize);
  if (window.length < minBaselineSamples) {
    return { outlier: false, median: null, deviationBps: null, baselineSize: window.length };
  }
  const median = medianOf(window.map((r, i) => parseRate(r, `recent[${i}]`)));
  const scale = Math.max(value.scale, median.scale);
  const r = rescale(value, scale);
  const m = rescale(median, scale);
  const diff = r > m ? r - m : m - r;
  return {
    outlier: diff * 10_000n > BigInt(thresholdBps) * m,
    median: format(median),
    deviationBps: Number((diff * 10_000n) / m),
    baselineSize: window.length,
  };
}

/**
 * Flag every sample of ONE series in a single pass, oldest first: each sample is checked
 * against the samples before it. Returns new objects with `outlier` set; input order is kept.
 * Use it to re-run the pass over stored history (then write changes back with
 * `PostgresRateHistoryStore.setOutlier`); for live collection use `recordFlaggingOutliers`.
 */
export function flagOutliers<T extends { rate: string; sampledAt: number }>(
  samples: readonly T[],
  policy?: OutlierPolicy,
): Array<T & { outlier: boolean }> {
  const resolved = resolvePolicy(policy);
  const order = samples
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.sampledAt - b.s.sampledAt || a.i - b.i);
  const out = new Array<T & { outlier: boolean }>(samples.length);
  const seen: string[] = [];
  for (const { s, i } of order) {
    out[i] = { ...s, outlier: checkOutlier(s.rate, seen, resolved).outlier };
    seen.push(s.rate);
    if (seen.length > resolved.windowSize) seen.shift();
  }
  return out;
}
