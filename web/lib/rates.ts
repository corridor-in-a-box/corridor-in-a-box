// Rate history chart data, built only from the published daily summaries.
//
// Every number here comes from `fetchRateSummaries()` (web/lib/rate-summaries.ts), the
// validated daily summary per pair and source (RFC 0004 §3). Nothing is generated or assumed:
// a day a source has no summary for, or a summary with no samples, is a gap, and the chart
// breaks its line there instead of drawing through it.

import type { RateSummary } from "./rate-summaries";

/** Days the chart shows per pair, counted back from the newest summary for that pair. */
export const RATE_HISTORY_CHART_DAYS = 30;

/**
 * RFC 0004 §3 minimum-data rule: an anchor gets the `estimated` label only with at least 7 days
 * of data and at least 100 samples in the window. The router applies the same defaults to raw
 * samples (`DEFAULT_MIN_ESTIMATE_SPAN_DAYS` and `DEFAULT_MIN_ESTIMATE_SAMPLES` in
 * packages/router/src/estimated-price.ts); the web app is outside the workspace, so they are
 * restated here.
 */
export const MIN_ESTIMATE_DAYS = 7;
export const MIN_ESTIMATE_SAMPLES = 100;
/** The estimate window, in days (RFC 0004 D3: P25 of the last 7 days). */
export const ESTIMATE_WINDOW_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * Whether a source's published summaries meet the minimum-data rule, and the counts behind it.
 *
 * - `daysWithData`: distinct UTC days that have a summary with at least one sample.
 * - `samplesInWindow`: samples summed over the 7 UTC days ending today (`windowStart`..`windowEnd`).
 *
 * This reads daily summaries, not raw samples, so it is what the published data shows; the
 * router still decides on the raw samples when it prices a route.
 */
export interface MinimumDataStatus {
  readonly daysWithData: number;
  readonly samplesInWindow: number;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly meetsRule: boolean;
}

export interface RateHistorySeries {
  readonly source: string;
  /** A reference FX series is drawn as the reference line and is not an anchor. */
  readonly kind: "anchor" | "reference";
  /** One entry per `dates` entry; `null` is a gap (no summary, or no samples that day). */
  readonly points: readonly (RateSummary | null)[];
  /** Only for anchor series: the reference rate is not priced, so the rule does not apply. */
  readonly minimumData?: MinimumDataStatus;
}

export interface PairRateHistory {
  readonly pair: string;
  /** Every UTC day from the first to the last summary shown, with no day skipped. */
  readonly dates: readonly string[];
  readonly series: readonly RateHistorySeries[];
}

const toDayMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
const fromDayMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * A source is the reference line only when it is the reference FX source (`reference_fx` in
 * packages/engine/src/rate-samples-pg.ts), optionally qualified, e.g. `reference_fx:provider`.
 */
export function isReferenceSource(source: string): boolean {
  return /^reference_fx(?::|$)/.test(source);
}

/** Normalises a pair or asset code for matching: `iso4217:NGN` and `NGN` are the same currency. */
const normaliseAsset = (asset: string) => asset.trim().replace(/^iso4217:/i, "").toUpperCase();

/** The summary pair a corridor's source and destination assets name, e.g. `USDC/NGN`. */
export function corridorPair(sourceAsset: string, destAsset: string): string {
  return `${normaliseAsset(sourceAsset)}/${normaliseAsset(destAsset)}`;
}

/** Whether a summary pair names the given pair, ignoring `iso4217:` prefixes and case. */
export function pairMatches(pair: string, wanted: string): boolean {
  const split = (p: string) => p.split("/").map(normaliseAsset).join("/");
  return split(pair) === split(wanted);
}

export function minimumDataStatus(
  summaries: readonly RateSummary[],
  now: Date = new Date(),
): MinimumDataStatus {
  const todayMs = toDayMs(now.toISOString().slice(0, 10));
  const windowStartMs = todayMs - (ESTIMATE_WINDOW_DAYS - 1) * DAY_MS;
  const days = new Set<string>();
  let samplesInWindow = 0;
  for (const s of summaries) {
    if (s.sampleCount <= 0) continue;
    const dayMs = toDayMs(s.date);
    if (dayMs > todayMs) continue;
    days.add(s.date);
    if (dayMs >= windowStartMs) samplesInWindow += s.sampleCount;
  }
  return {
    daysWithData: days.size,
    samplesInWindow,
    windowStart: fromDayMs(windowStartMs),
    windowEnd: fromDayMs(todayMs),
    meetsRule: days.size >= MIN_ESTIMATE_DAYS && samplesInWindow >= MIN_ESTIMATE_SAMPLES,
  };
}

/**
 * Groups daily summaries into one chart per pair: one series per source, aligned to a run of
 * consecutive days so a missing day shows as a gap. Pairs and sources come out sorted.
 */
export function buildRateHistory(
  summaries: readonly RateSummary[],
  options: { now?: Date; days?: number } = {},
): PairRateHistory[] {
  const now = options.now ?? new Date();
  const chartDays = options.days ?? RATE_HISTORY_CHART_DAYS;

  const byPair = new Map<string, Map<string, RateSummary[]>>();
  for (const s of summaries) {
    const bySource = byPair.get(s.pair) ?? new Map<string, RateSummary[]>();
    byPair.set(s.pair, bySource);
    const list = bySource.get(s.source) ?? [];
    list.push(s);
    bySource.set(s.source, list);
  }

  const histories: PairRateHistory[] = [];
  for (const [pair, bySource] of [...byPair].sort(([a], [b]) => a.localeCompare(b))) {
    const withData = [...bySource.values()].flat().filter((s) => s.sampleCount > 0);
    if (withData.length === 0) continue;

    const lastMs = Math.max(...withData.map((s) => toDayMs(s.date)));
    const firstMs = Math.max(
      Math.min(...withData.map((s) => toDayMs(s.date))),
      lastMs - (chartDays - 1) * DAY_MS,
    );
    const dates: string[] = [];
    for (let ms = firstMs; ms <= lastMs; ms += DAY_MS) dates.push(fromDayMs(ms));

    const series: RateHistorySeries[] = [];
    for (const [source, list] of [...bySource].sort(([a], [b]) => a.localeCompare(b))) {
      const byDate = new Map<string, RateSummary>();
      for (const s of list) if (s.sampleCount > 0) byDate.set(s.date, s);
      const points = dates.map((d) => byDate.get(d) ?? null);
      if (points.every((p) => p === null)) continue;
      const kind = isReferenceSource(source) ? "reference" : "anchor";
      series.push(
        kind === "anchor"
          ? { source, kind, points, minimumData: minimumDataStatus(list, now) }
          : { source, kind, points },
      );
    }
    histories.push({ pair, dates, series });
  }
  return histories;
}

/** A point on the chart. `value` is the plotted position only; labels show the source string. */
export interface ChartCoordinate {
  readonly x: number;
  readonly y: number;
  readonly date: string;
  readonly value: string;
}

export interface DiscontinuousPathSegment {
  readonly points: readonly ChartCoordinate[];
}

/**
 * Splits one series into runs of consecutive days with data, so a line is never drawn across a
 * gap. `pick` chooses which statistic to plot (e.g. the median or the P25).
 */
export function buildSeriesSegments(
  dates: readonly string[],
  points: readonly (RateSummary | null)[],
  pick: (summary: RateSummary) => string,
  mapX: (index: number) => number,
  mapY: (rate: number) => number,
): DiscontinuousPathSegment[] {
  const segments: DiscontinuousPathSegment[] = [];
  let current: ChartCoordinate[] = [];

  points.forEach((summary, index) => {
    const value = summary ? pick(summary) : undefined;
    const rate = value === undefined ? Number.NaN : Number(value);
    if (value !== undefined && Number.isFinite(rate)) {
      current.push({ x: mapX(index), y: mapY(rate), date: dates[index], value });
    } else if (current.length > 0) {
      segments.push({ points: current });
      current = [];
    }
  });
  if (current.length > 0) segments.push({ points: current });

  return segments;
}

/** An SVG path that starts a new `M` subpath for every segment, so gaps stay open. */
export function segmentsToSvgPath(segments: readonly DiscontinuousPathSegment[]): string {
  const parts: string[] = [];
  for (const seg of segments) {
    if (seg.points.length === 0) continue;
    const [first, ...rest] = seg.points;
    let path = `M ${first.x.toFixed(2)} ${first.y.toFixed(2)}`;
    for (const p of rest) path += ` L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
    parts.push(path);
  }
  return parts.join(" ");
}

/**
 * A closed band between each segment's P25 and median, one subpath per segment, so the shaded
 * area also stops at gaps. Returns "" when there is nothing to shade.
 */
export function bandSegmentsToSvgPath(
  dates: readonly string[],
  points: readonly (RateSummary | null)[],
  mapX: (index: number) => number,
  mapY: (rate: number) => number,
): string {
  const lower = buildSeriesSegments(dates, points, (s) => s.p25, mapX, mapY);
  const upper = buildSeriesSegments(dates, points, (s) => s.median, mapX, mapY);
  const parts: string[] = [];
  lower.forEach((low, i) => {
    const high = upper[i];
    if (!high || low.points.length === 0) return;
    const top = high.points.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`);
    const bottom = [...low.points].reverse().map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`);
    parts.push(`M ${top.join(" L ")} L ${bottom.join(" L ")} Z`);
  });
  return parts.join(" ");
}
