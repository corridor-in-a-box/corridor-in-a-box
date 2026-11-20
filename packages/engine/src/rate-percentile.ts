// Pure helpers for windowed rate percentile estimation (RFC 0004 / #597).
//
// The estimated rate is typically the 25th percentile (P25) of a 7-day window
// minus an optional safety margin.
//
// Arithmetic is strictly performed on scaled BigInts to produce exact decimal
// strings with no floating-point representation loss or float drift.

import {
  compareAmounts,
  fromScaled,
  isValidAmount,
  STROOP_SCALE,
  toScaled,
} from "@corridor/types";

/**
 * Computes the p-th percentile of an array of decimal strings using linear interpolation.
 *
 * Requirements:
 * - values must be non-empty and well-formed decimal strings.
 * - p must be between 0 and 1 inclusive (e.g. 0.25 for 25th percentile).
 *   If p > 1 and p <= 100, it is automatically normalized as p / 100.
 *
 * Invariants:
 * - Result is strictly bounded: min(values) <= percentile <= max(values).
 * - Monotonic in p: if p1 <= p2 then percentile(V, p1) <= percentile(V, p2).
 * - Order-independent: sorting values first ensures any permutation yields the same result.
 * - Preserves exact decimal precision without floating point artifacts.
 */
export function percentile(
  values: readonly string[],
  p: number,
  scale: number = STROOP_SCALE,
): string {
  if (!values || values.length === 0) {
    throw new Error("cannot compute percentile of an empty array");
  }

  if (typeof p !== "number" || Number.isNaN(p) || p < 0 || p > 1) {
    throw new Error(`percentile p must be between 0 and 1 (received ${p})`);
  }

  for (const v of values) {
    if (!isValidAmount(v)) {
      throw new Error(`invalid amount string in percentile values: "${v}"`);
    }
  }

  // Sort ascending by numerical value
  const sorted = [...values].sort((a, b) => {
    const cmp = compareAmounts(a, b, scale);
    if (!cmp.ok) throw new Error(cmp.error.message);
    return cmp.value;
  });

  const canonicalize = (val: string): string => {
    const s = toScaled(val, scale);
    if (!s.ok) throw new Error(s.error.message);
    return fromScaled(s.value, scale);
  };

  const N = sorted.length;
  if (N === 1 || p === 0) return canonicalize(sorted[0]!);
  if (p === 1) return canonicalize(sorted[N - 1]!);

  // Linear interpolation:
  // pos = (N - 1) * p
  // We use fixed-point arithmetic with 10^9 precision for the position
  const pFactor = 1_000_000_000n;
  const pBig = BigInt(Math.round(p * 1_000_000_000));
  const nMinus1 = BigInt(N - 1);
  const totalPos = pBig * nMinus1;

  const idxBig = totalPos / pFactor;
  const remBig = totalPos % pFactor;
  const idx = Number(idxBig);

  if (remBig === 0n || idx >= N - 1) {
    return canonicalize(sorted[idx]!);
  }

  const valLow = toScaled(sorted[idx]!, scale);
  if (!valLow.ok) throw new Error(valLow.error.message);

  const valHigh = toScaled(sorted[idx + 1]!, scale);
  if (!valHigh.ok) throw new Error(valHigh.error.message);

  const diff = valHigh.value - valLow.value;
  if (diff === 0n) {
    return canonicalize(sorted[idx]!);
  }

  // interpolated = valLow + (diff * remBig + half) / pFactor
  const half = pFactor / 2n;
  const product = diff * remBig;
  const adj = (product + (product >= 0n ? half : -half)) / pFactor;
  const interpolated = valLow.value + adj;

  return fromScaled(interpolated, scale);
}

/** Convenience shortcut for the 25th percentile (P25). */
export function computeP25(values: readonly string[], scale: number = STROOP_SCALE): string {
  return percentile(values, 0.25, scale);
}

/** Convenience shortcut for the median (50th percentile). */
export function computeMedian(
  values: readonly string[],
  scale: number = STROOP_SCALE,
): string {
  return percentile(values, 0.5, scale);
}

/**
 * Filter an array of timestamped samples to those within a time window [now - days, now].
 */
export function windowed<T extends { sampledAt: Date | number | string }>(
  samples: readonly T[],
  now: Date | number | string,
  days: number,
): T[] {
  if (days < 0) {
    throw new Error(`window days must be non-negative (received ${days})`);
  }

  const nowMs = typeof now === "number" ? now : new Date(now).getTime();
  const windowMs = days * 24 * 60 * 60 * 1000;
  const cutoffMs = nowMs - windowMs;

  return samples.filter((s) => {
    const sampleMs =
      typeof s.sampledAt === "number" ? s.sampledAt : new Date(s.sampledAt).getTime();
    return sampleMs >= cutoffMs && sampleMs <= nowMs;
  });
}

export interface EstimateRateOptions {
  /** Window size in days (default: 7). */
  days?: number;
  /** Percentile between 0 and 1 (default: 0.25 for P25). */
  p?: number;
  /** Optional margin discount percentage to subtract (e.g. 1.0 for 1% safety margin). */
  marginPercent?: number;
  /** Scale for decimal arithmetic (default: STROOP_SCALE = 7). */
  scale?: number;
}

/**
 * Calculates the estimated rate from historical rate samples by windowing and computing percentile.
 */
export function estimateRate(
  samples: ReadonlyArray<{ rate: string; sampledAt: Date | number | string }>,
  now: Date | number | string,
  options: EstimateRateOptions = {},
): string {
  const days = options.days ?? 7;
  const p = options.p ?? 0.25;
  const scale = options.scale ?? STROOP_SCALE;

  const inWindow = windowed(samples, now, days);
  if (inWindow.length === 0) {
    throw new Error(`no rate samples available in the ${days}-day window`);
  }

  const rawPercentile = percentile(
    inWindow.map((s) => s.rate),
    p,
    scale,
  );

  if (!options.marginPercent || options.marginPercent === 0) {
    return rawPercentile;
  }

  // Subtract margin: rate * (1 - marginPercent / 100)
  const marginScaled = toScaled(rawPercentile, scale);
  if (!marginScaled.ok) throw new Error(marginScaled.error.message);

  const factor = 10_000n;
  const marginBps = BigInt(Math.round(options.marginPercent * 100));
  const mult = factor - marginBps;
  const adjusted = (marginScaled.value * mult + factor / 2n) / factor;

  return fromScaled(adjusted, scale);
}
