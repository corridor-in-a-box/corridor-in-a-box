// Percentile and window helpers for rate history (#597).
//
// Example tests pin the documented method; the property tests check the
// invariants for many generated inputs. Like money-properties.test.ts, no
// property-testing dependency: a seeded generator gives reproducible runs and a
// failure message prints the input that broke the property.

import { describe, expect, it } from "vitest";
import {
  buildEstimatedOption,
  canonicalDecimal,
  compareDecimals,
  percentile,
  percentileRank,
  windowed,
  type RateSample,
} from "@corridor/router";

/** Deterministic PRNG (mulberry32), seeded so a failing run can be replayed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RUNS = 400;
const DAY = 86_400_000;

/** A positive decimal rate string with up to 20 places, sometimes with padding zeros. */
function rate(r: () => number): string {
  const int = Math.floor(r() * 10 ** Math.floor(r() * 7)).toString();
  const places = Math.floor(r() * 21);
  let frac = Array.from({ length: places }, () => Math.floor(r() * 10)).join("");
  if (r() < 0.2) frac += "000";
  const lead = r() < 0.1 ? "00" : "";
  const s = places === 0 && frac === "" ? `${lead}${int}` : `${lead}${int}.${frac || "0"}`;
  return /[1-9]/.test(s) ? s : "1";
}

function rates(r: () => number): string[] {
  return Array.from({ length: 1 + Math.floor(r() * 60) }, () => rate(r));
}

function shuffle<T>(r: () => number, xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("percentile (#597)", () => {
  it('uses the "lower" method: the value at floor(p × (n − 1)) in ascending order', () => {
    const v = ["5", "1", "4", "2", "3"]; // sorted: 1 2 3 4 5
    expect(percentile(v, 0)).toBe("1");
    expect(percentile(v, 0.25)).toBe("2"); // floor(0.25 × 4) = 1
    expect(percentile(v, 0.5)).toBe("3");
    expect(percentile(v, 0.74)).toBe("3"); // floor(2.96) = 2
    expect(percentile(v, 0.75)).toBe("4");
    expect(percentile(v, 1)).toBe("5");
    // Six values: floor(0.25 × 5) = 1, no interpolation between 1.1 and 1.2.
    expect(percentile(["1.0", "1.1", "1.2", "1.3", "1.4", "1.5"], 0.25)).toBe("1.1");
  });

  it("reads p as the decimal it is written as, not its float approximation", () => {
    // 0.29 × 100 is 28.999999999999996 in floats; the rank must still be 29.
    expect(0.29 * 100).toBeLessThan(29);
    expect(percentileRank(101, 0.29)).toBe(29);
    expect(percentileRank(1, 0.5)).toBe(0);
    expect(percentileRank(4, 1)).toBe(3);
    expect(percentileRank(1_000_001, 1e-6)).toBe(1);
  });

  it("keeps every digit and returns the canonical form", () => {
    expect(percentile(["0.000000000000000123456789", "9"], 0)).toBe(
      "0.000000000000000123456789",
    );
    expect(percentile(["0012.3400", "99"], 0)).toBe("12.34");
    expect(percentile(["1530.1234567890123456789"], 0.25)).toBe("1530.1234567890123456789");
  });

  it("rejects an empty list, a malformed value and p outside [0, 1]", () => {
    expect(() => percentile([], 0.25)).toThrow(RangeError);
    expect(() => percentile(["1", "abc"], 0.25)).toThrow(/values\[1\]/);
    expect(() => percentile(["1", "-2"], 0.25)).toThrow(RangeError);
    expect(() => percentile(["1", "1e3"], 0.25)).toThrow(RangeError);
    for (const p of [-0.01, 1.01, 25, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => percentile(["1"], p), String(p)).toThrow(RangeError);
    }
  });

  it("property: the result is one of the inputs and lies within [min, max]", () => {
    const r = rng(0x597a);
    for (let i = 0; i < RUNS; i++) {
      const v = rates(r);
      const p = r();
      const got = percentile(v, p);
      const ctx = JSON.stringify({ v, p, got });
      expect(
        v.some((x) => compareDecimals(x, got) === 0),
        ctx,
      ).toBe(true);
      expect(got, ctx).toBe(canonicalDecimal(got));
      const sorted = [...v].sort(compareDecimals);
      expect(compareDecimals(sorted[0]!, got), ctx).toBeLessThanOrEqual(0);
      expect(compareDecimals(got, sorted[sorted.length - 1]!), ctx).toBeLessThanOrEqual(0);
    }
  });

  it("property: monotonic in p", () => {
    const r = rng(0x597b);
    for (let i = 0; i < RUNS; i++) {
      const v = rates(r);
      const [p1, p2] = [r(), r()].sort((a, b) => a - b) as [number, number];
      const lo = percentile(v, p1);
      const hi = percentile(v, p2);
      expect(
        compareDecimals(lo, hi),
        JSON.stringify({ v, p1, p2, lo, hi }),
      ).toBeLessThanOrEqual(0);
    }
  });

  it("property: independent of input order, as a string", () => {
    const r = rng(0x597c);
    for (let i = 0; i < RUNS; i++) {
      const v = rates(r);
      // Same values with different spellings (padding zeros) must not change the answer.
      const respelled = v.map((x) => (r() < 0.5 ? x : x.includes(".") ? `${x}00` : `${x}.0`));
      const p = [0, 0.25, 0.5, 0.75, 1, r()][Math.floor(r() * 6)]!;
      expect(percentile(shuffle(r, respelled), p), JSON.stringify({ v, p })).toBe(
        percentile(v, p),
      );
    }
  });
});

describe("windowed (#597)", () => {
  const now = Date.UTC(2026, 10, 25, 12);

  it("keeps samples from now − days to now, both ends inclusive, in input order", () => {
    const s = [
      { id: "future", timestampMs: now + 1 },
      { id: "now", timestampMs: now },
      { id: "edge", timestampMs: now - 7 * DAY },
      { id: "old", timestampMs: now - 7 * DAY - 1 },
      { id: "mid", timestampMs: now - 3 * DAY },
      { id: "nan", timestampMs: Number.NaN },
    ];
    expect(windowed(s, now, 7).map((x) => x.id)).toEqual(["now", "edge", "mid"]);
  });

  it("reads another time field through timeOf", () => {
    const s = [
      { sampledAt: now - DAY, rate: "1" },
      { sampledAt: now - 9 * DAY, rate: "2" },
    ];
    expect(windowed(s, now, 7, (x) => x.sampledAt)).toEqual([s[0]]);
  });

  it("rejects a bad window", () => {
    expect(() => windowed([], now, -1)).toThrow(RangeError);
    expect(() => windowed([], now, Number.NaN)).toThrow(RangeError);
    expect(() => windowed([], Number.NaN, 7)).toThrow(RangeError);
  });

  it("property: keeps exactly the samples inside the window", () => {
    const r = rng(0x597d);
    for (let i = 0; i < RUNS; i++) {
      const days = Math.floor(r() * 10);
      const s = Array.from({ length: Math.floor(r() * 40) }, (_, id) => ({
        id,
        timestampMs: now + Math.floor((r() - 0.8) * 12 * DAY),
      }));
      const got = windowed(s, now, days);
      const want = s.filter((x) => x.timestampMs >= now - days * DAY && x.timestampMs <= now);
      expect(got, JSON.stringify({ days, s })).toEqual(want);
    }
  });
});

describe("estimated price uses the shared helpers (#597, RFC 0004 D3)", () => {
  it("property: p25Rate is percentile(windowed rates, 0.25)", () => {
    const r = rng(0x597e);
    const now = Date.UTC(2026, 10, 25);
    for (let i = 0; i < 100; i++) {
      const history: RateSample[] = Array.from({ length: 1 + Math.floor(r() * 80) }, () => ({
        rate: rate(r),
        timestampMs: now - Math.floor(r() * 10 * DAY),
      }));
      // Something old enough that the 7-day history requirement is met.
      history.push({ rate: "1", timestampMs: now - 8 * DAY });
      const out = buildEstimatedOption({
        receivingDomain: "anchor.example",
        sourceAmount: { asset: "USDC", amount: "100" },
        destAsset: "iso4217:NGN",
        history,
        policy: { minEstimateSamples: 1 },
        nowMs: now,
      });
      if (out.status !== "offered") throw new Error(`expected an offer: ${out.reason}`);
      const want = percentile(
        windowed(history, now, 7).map((h) => h.rate),
        0.25,
      );
      expect(compareDecimals(out.price.p25Rate, want), JSON.stringify(history)).toBe(0);
    }
  });
});
