// Rate history data and utilities for the corridor-in-a-box dashboard.
//
// RFC 0004 Smart Router routing intelligence uses rate stability and percentile
// bands (P25) to determine estimated pricing and route confidence. Gaps indicate
// periods where an anchor had downtime, was unprobed, or published no rates.

export interface DailyRatePoint {
  /** ISO date string "YYYY-MM-DD" */
  readonly date: string;
  /** Market reference rate for the day (e.g. mid-market benchmark) */
  readonly referenceRate: number;
  /** 25th percentile threshold rate used for router estimates */
  readonly p25: number;
  /**
   * Anchor rate on this date.
   * `null` explicitly indicates that no rate data was collected (gap).
   */
  readonly rates: Record<string, number | null>;
}

export interface CurrencyPairRateHistory {
  readonly pair: string;
  readonly displayPair: string;
  readonly sourceAsset: string;
  readonly destAsset: string;
  readonly baseSpreadBps: number;
  readonly referenceRate: number;
  readonly anchors: readonly string[];
  readonly points: readonly DailyRatePoint[];
  readonly stabilityScore: "high" | "moderate" | "volatile";
  readonly estimatedEligible: boolean;
}

export interface DailySummaryResponse {
  readonly pairs: CurrencyPairRateHistory[];
}

/**
 * Deterministic pseudo-random number generator for stable mock rate history.
 */
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

/**
 * Formats a Date object to YYYY-MM-DD.
 */
function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Builds 30 days of historical rate data for a currency pair.
 * Incorporates realistic volatility, reference rate, P25 estimate band,
 * and deliberate gaps where data was not collected.
 */
function generatePairHistory(
  pair: string,
  displayPair: string,
  sourceAsset: string,
  destAsset: string,
  baseRate: number,
  anchors: string[],
  seed: number,
  gapDaysForAnchor: Record<string, number[]>,
): CurrencyPairRateHistory {
  const rng = seededRandom(seed);
  const days = 30;
  const now = new Date(Date.UTC(2026, 10, 22)); // 2026-11-22
  const points: DailyRatePoint[] = [];

  // Slight drift for reference rate over 30 days
  let currentRef = baseRate;

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const dateStr = formatDate(d);

    // Reference rate drifts by up to ±0.2% daily
    const dailyDrift = (rng() - 0.49) * 0.004 * baseRate;
    currentRef = Math.round((currentRef + dailyDrift) * 10000) / 10000;

    // Anchor rates and P25 computation
    const rates: Record<string, number | null> = {};
    const validRates: number[] = [];

    for (const anchor of anchors) {
      const gaps = gapDaysForAnchor[anchor] ?? [];
      const dayIndex = days - 1 - i;
      if (gaps.includes(dayIndex)) {
        // Gap! No data was collected on this date for this anchor
        rates[anchor] = null;
      } else {
        // Individual anchor spreads (between -0.5% and +0.8% of reference)
        const spread = (rng() - 0.45) * 0.01 * currentRef;
        const rate = Math.round((currentRef + spread) * 10000) / 10000;
        rates[anchor] = rate;
        validRates.push(rate);
      }
    }

    // P25 band: 25th percentile of collected rates (or conservative 0.5% below reference if few)
    let p25Val: number;
    if (validRates.length > 0) {
      validRates.sort((a, b) => a - b);
      const p25Index = Math.floor(validRates.length * 0.25);
      const calculatedP25 = validRates[p25Index];
      // Bound P25 slightly below reference to form a meaningful estimate band
      p25Val = Math.min(calculatedP25, Math.round(currentRef * 0.994 * 10000) / 10000);
    } else {
      p25Val = Math.round(currentRef * 0.994 * 10000) / 10000;
    }

    points.push({
      date: dateStr,
      referenceRate: currentRef,
      p25: p25Val,
      rates,
    });
  }

  return {
    pair,
    displayPair,
    sourceAsset,
    destAsset,
    baseSpreadBps: 25,
    referenceRate: points[points.length - 1].referenceRate,
    anchors,
    points,
    stabilityScore: "high",
    estimatedEligible: true,
  };
}

/**
 * Built-in dataset for rate history across the manifest corridors.
 */
export function getDailySummaryData(): DailySummaryResponse {
  const pairs: CurrencyPairRateHistory[] = [
    generatePairHistory(
      "USDC/iso4217:USD",
      "USDC/USD",
      "USDC",
      "iso4217:USD",
      1.0,
      ["testanchor.stellar.org", "mock-anchor.stellar.org"],
      101,
      {
        "testanchor.stellar.org": [6, 7], // Gaps on days 6 and 7
        "mock-anchor.stellar.org": [18], // Gap on day 18
      },
    ),
    generatePairHistory(
      "USDC/iso4217:NGN",
      "USDC/NGN",
      "USDC",
      "iso4217:NGN",
      1585.5,
      ["cowrie.exchange", "testanchor.stellar.org"],
      202,
      {
        "cowrie.exchange": [11, 12, 13], // Gap on days 11-13
        "testanchor.stellar.org": [24], // Gap on day 24
      },
    ),
    generatePairHistory(
      "USDC/iso4217:MXN",
      "USDC/MXN",
      "USDC",
      "iso4217:MXN",
      18.35,
      ["mx-example.stellar.org"],
      303,
      {
        "mx-example.stellar.org": [9, 10], // Gap on days 9 and 10
      },
    ),
    generatePairHistory(
      "USDC/iso4217:CNY",
      "USDC/CNY",
      "USDC",
      "iso4217:CNY",
      7.24,
      ["ng-cn.stellar.org"],
      404,
      {
        "ng-cn.stellar.org": [15], // Gap on day 15
      },
    ),
    generatePairHistory(
      "USDC/iso4217:ZAR",
      "USDC/ZAR",
      "USDC",
      "iso4217:ZAR",
      18.12,
      ["zeam.io"],
      505,
      {
        "zeam.io": [5, 21], // Gaps on days 5 and 21
      },
    ),
  ];

  return { pairs };
}

/**
 * Calculates continuous path segments for an anchor so gaps (null values)
 * are not drawn through. Returns an array of coordinate segments, where each
 * segment is a continuous series of points.
 */
export interface ChartCoordinate {
  x: number;
  y: number;
  date: string;
  rate: number;
}

export interface DiscontinuousPathSegment {
  readonly points: readonly ChartCoordinate[];
}

export function buildAnchorSegments(
  points: readonly DailyRatePoint[],
  anchor: string,
  mapX: (index: number) => number,
  mapY: (rate: number) => number,
): DiscontinuousPathSegment[] {
  const segments: DiscontinuousPathSegment[] = [];
  let currentSegment: ChartCoordinate[] = [];

  points.forEach((pt, index) => {
    const rate = pt.rates[anchor];
    if (rate !== null && rate !== undefined && !Number.isNaN(rate)) {
      currentSegment.push({
        x: mapX(index),
        y: mapY(rate),
        date: pt.date,
        rate,
      });
    } else {
      // Gap encountered: finish current segment if non-empty
      if (currentSegment.length > 0) {
        segments.push({ points: currentSegment });
        currentSegment = [];
      }
    }
  });

  if (currentSegment.length > 0) {
    segments.push({ points: currentSegment });
  }

  return segments;
}

/**
 * Constructs an SVG path 'd' string from discontinuous segments.
 * Uses 'M' to start each segment, avoiding drawing lines through missing gaps.
 */
export function segmentsToSvgPath(segments: readonly DiscontinuousPathSegment[]): string {
  if (segments.length === 0) return "";
  const parts: string[] = [];

  for (const seg of segments) {
    if (seg.points.length === 0) continue;
    const first = seg.points[0];
    let path = `M ${first.x.toFixed(2)} ${first.y.toFixed(2)}`;
    for (let i = 1; i < seg.points.length; i++) {
      const p = seg.points[i];
      path += ` L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
    }
    parts.push(path);
  }

  return parts.join(" ");
}
