// Windowed percentiles over rate history. RFC 0004 D3, issue #597.
//
// The `estimated` price is the P25 of a 7-day window minus a margin, so a wrong
// percentile silently mis-prices payments. These helpers are the one place that
// math lives: `estimated-price.ts` builds on them, and so should anything else
// that summarises rate samples (the daily min / P25 / median / P75 / max).
//
// Method: "lower" (numpy's `method="lower"`). Sort the values ascending and take
// the one at index floor(p × (n − 1)). The result is always one of the observed
// rates, never an interpolation between two, so:
// - there is no rounding and no float drift: the answer is an input, digit for digit
//   (in canonical form: no leading zeros, no trailing fractional zeros);
// - it always lies within [min, max] and never decreases as p grows;
// - it does not depend on the order of the input.
// Rates stay decimal strings throughout and are compared as BigInts. `p` is read as
// the decimal it is written as (0.29 means 29/100), so the index is exact too.

const DECIMAL_RE = /^\d+(?:\.\d+)?$/;
const DAY_MS = 86_400_000;

interface Parsed {
  digits: bigint;
  scale: number;
}

function parse(value: string, field: string): Parsed {
  const s = typeof value === "string" ? value.trim() : "";
  if (!DECIMAL_RE.test(s)) {
    throw new RangeError(
      `${field} must be a non-negative decimal string, got ${JSON.stringify(value)}`,
    );
  }
  const dot = s.indexOf(".");
  if (dot === -1) return { digits: BigInt(s), scale: 0 };
  return { digits: BigInt(s.slice(0, dot) + s.slice(dot + 1)), scale: s.length - dot - 1 };
}

function compareParsed(a: Parsed, b: Parsed): -1 | 0 | 1 {
  const scale = Math.max(a.scale, b.scale);
  const x = a.digits * 10n ** BigInt(scale - a.scale);
  const y = b.digits * 10n ** BigInt(scale - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

function format(p: Parsed): string {
  if (p.scale === 0) return p.digits.toString();
  const s = p.digits.toString().padStart(p.scale + 1, "0");
  const whole = s.slice(0, s.length - p.scale);
  const frac = s.slice(s.length - p.scale).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** Compares two non-negative decimal strings exactly. Throws RangeError on a malformed one. */
export function compareDecimals(a: string, b: string): -1 | 0 | 1 {
  return compareParsed(parse(a, "a"), parse(b, "b"));
}

/** A non-negative decimal string in canonical form: "007.50" becomes "7.5". */
export function canonicalDecimal(value: string): string {
  return format(parse(value, "value"));
}

/** `p` as an exact fraction num/den, read as the decimal it is written as. */
function pAsFraction(p: number): { num: bigint; den: bigint } {
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
    throw new RangeError(`p must be a number from 0 to 1, got ${String(p)}`);
  }
  let s = String(p);
  if (s.includes("e")) s = p.toFixed(20);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new RangeError(`p must be a number from 0 to 1, got ${String(p)}`);
  const frac = m[2] ?? "";
  return { num: BigInt(m[1]! + frac), den: 10n ** BigInt(frac.length) };
}

/**
 * The index, in ascending order, of the p-th percentile of `count` values:
 * floor(p × (count − 1)). `p` is a fraction from 0 to 1 (0.25 for P25).
 */
export function percentileRank(count: number, p: number): number {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError(`count must be a positive integer, got ${String(count)}`);
  }
  const { num, den } = pAsFraction(p);
  return Number((num * BigInt(count - 1)) / den);
}

/**
 * The p-th percentile of non-negative decimal strings, by the "lower" method (see
 * the header). Returns the chosen value in canonical form. Throws RangeError on an
 * empty list, a malformed value or a p outside [0, 1].
 */
export function percentile(values: readonly string[], p: number): string {
  if (values.length === 0) throw new RangeError("cannot take a percentile of no values");
  const parsed = values.map((v, i) => parse(v, `values[${i}]`));
  parsed.sort(compareParsed);
  return format(parsed[percentileRank(parsed.length, p)]!);
}

function assertWindow(nowMs: number, days: number): number {
  if (!Number.isFinite(nowMs)) throw new RangeError("nowMs must be a finite epoch ms number");
  if (!Number.isFinite(days) || days < 0) {
    throw new RangeError(`days must be a finite number >= 0, got ${String(days)}`);
  }
  return nowMs - days * DAY_MS;
}

/**
 * The samples observed in the last `days` days up to `nowMs`, both ends inclusive,
 * in their original order. A sample in the future, or without a finite time, is
 * left out. Times are read from `timestampMs` unless `timeOf` says otherwise.
 */
export function windowed<T extends { timestampMs: number }>(
  samples: readonly T[],
  nowMs: number,
  days: number,
): T[];
export function windowed<T>(
  samples: readonly T[],
  nowMs: number,
  days: number,
  timeOf: (sample: T) => number,
): T[];
export function windowed<T>(
  samples: readonly T[],
  nowMs: number,
  days: number,
  timeOf: (sample: T) => number = (s) => (s as { timestampMs: number }).timestampMs,
): T[] {
  const startMs = assertWindow(nowMs, days);
  return samples.filter((s) => {
    const t = timeOf(s);
    return Number.isFinite(t) && t >= startMs && t <= nowMs;
  });
}
