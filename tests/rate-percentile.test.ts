import { describe, expect, it } from "vitest";
import {
  percentile,
  computeP25,
  computeMedian,
  windowed,
  estimateRate,
} from "@corridor/engine";
import { compareAmounts, isValidAmount } from "@corridor/types";

/** Seeded deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generate a realistic decimal rate string. */
function randomRate(r: () => number): string {
  const intPart = Math.floor(r() * 2000).toString();
  const places = 1 + Math.floor(r() * 6);
  const fracPart = Array.from({ length: places }, () => Math.floor(r() * 10)).join("");
  return `${intPart}.${fracPart}`;
}

function cmp(a: string, b: string): number {
  const res = compareAmounts(a, b);
  if (!res.ok) throw new Error(res.error.message);
  return res.value;
}

describe("rate-percentile: unit tests (#597)", () => {
  it("throws on an empty array", () => {
    expect(() => percentile([], 0.5)).toThrow("cannot compute percentile of an empty array");
  });

  it("throws on invalid p (< 0 or > 1)", () => {
    expect(() => percentile(["100.0"], -0.1)).toThrow("percentile p must be between 0 and 1");
    expect(() => percentile(["100.0"], 1.1)).toThrow("percentile p must be between 0 and 1");
    expect(() => percentile(["100.0"], 50)).toThrow("percentile p must be between 0 and 1");
  });

  it("returns the exact single value for 1-element arrays regardless of p", () => {
    expect(percentile(["42.50"], 0)).toBe("42.5");
    expect(percentile(["42.50"], 0.25)).toBe("42.5");
    expect(percentile(["42.50"], 0.5)).toBe("42.5");
    expect(percentile(["42.50"], 1)).toBe("42.5");
  });

  it("computes exact linear interpolation percentiles for known small arrays", () => {
    // Array: [10, 20, 30]
    // N = 3, N - 1 = 2
    // p=0: 10
    // p=0.25: pos = 2 * 0.25 = 0.5 -> 10 + 0.5 * (20 - 10) = 15
    // p=0.5: pos = 2 * 0.5 = 1.0 -> 20
    // p=0.75: pos = 2 * 0.75 = 1.5 -> 20 + 0.5 * (30 - 20) = 25
    // p=1.0: 30
    const vals = ["10", "20", "30"];
    expect(percentile(vals, 0)).toBe("10");
    expect(percentile(vals, 0.25)).toBe("15");
    expect(computeP25(vals)).toBe("15");
    expect(percentile(vals, 0.5)).toBe("20");
    expect(computeMedian(vals)).toBe("20");
    expect(percentile(vals, 0.75)).toBe("25");
    expect(percentile(vals, 1)).toBe("30");
  });

  it("handles duplicate and unsorted values cleanly", () => {
    const unsorted = ["30", "10", "20", "20"];
    expect(percentile(unsorted, 0)).toBe("10");
    expect(percentile(unsorted, 1)).toBe("30");
    expect(percentile(unsorted, 0.5)).toBe("20");
  });
});

describe("rate-percentile: windowed helper", () => {
  const baseNow = new Date("2026-11-20T12:00:00Z").getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  const samples = [
    { rate: "1.0", sampledAt: new Date(baseNow - 10 * dayMs) }, // 10 days ago (outside 7d window)
    { rate: "1.2", sampledAt: new Date(baseNow - 6 * dayMs) }, // 6 days ago (inside)
    { rate: "1.3", sampledAt: new Date(baseNow - 3 * dayMs) }, // 3 days ago (inside)
    { rate: "1.4", sampledAt: new Date(baseNow - 1 * dayMs) }, // 1 day ago (inside)
    { rate: "1.5", sampledAt: new Date(baseNow + 1 * dayMs) }, // future (outside)
  ];

  it("filters samples strictly within [now - days, now]", () => {
    const inWindow = windowed(samples, baseNow, 7);
    expect(inWindow).toHaveLength(3);
    expect(inWindow.map((s) => s.rate)).toEqual(["1.2", "1.3", "1.4"]);
  });

  it("estimateRate computes P25 with optional margin discount", () => {
    // 3 samples in window: [1.2, 1.3, 1.4]
    // N = 3, N - 1 = 2
    // pos = 2 * 0.25 = 0.5 -> 1.2 + 0.5 * (1.3 - 1.2) = 1.25
    const rateWithoutMargin = estimateRate(samples, baseNow, { days: 7, p: 0.25 });
    expect(rateWithoutMargin).toBe("1.25");

    // With 1% safety margin: 1.25 * (1 - 0.01) = 1.25 * 0.99 = 1.2375
    const rateWithMargin = estimateRate(samples, baseNow, {
      days: 7,
      p: 0.25,
      marginPercent: 1.0,
    });
    expect(rateWithMargin).toBe("1.2375");
  });
});

describe("rate-percentile: property tests (#597)", () => {
  const r = rng(20261120);

  it("invariant 1: result is always bounded within [min, max] for all p in [0, 1]", () => {
    for (let i = 0; i < 400; i++) {
      const len = 1 + Math.floor(r() * 25);
      const vals = Array.from({ length: len }, () => randomRate(r));
      const p = r();

      const res = percentile(vals, p);
      expect(isValidAmount(res)).toBe(true);

      // Sort vals to find min and max
      const sorted = [...vals].sort((a, b) => cmp(a, b));
      const min = sorted[0]!;
      const max = sorted[sorted.length - 1]!;

      expect(cmp(res, min)).toBeGreaterThanOrEqual(0);
      expect(cmp(res, max)).toBeLessThanOrEqual(0);
    }
  });

  it("invariant 2: monotonic in p (if p1 <= p2 then percentile(p1) <= percentile(p2))", () => {
    for (let i = 0; i < 400; i++) {
      const len = 1 + Math.floor(r() * 20);
      const vals = Array.from({ length: len }, () => randomRate(r));
      const p1 = r();
      const p2 = p1 + r() * (1 - p1); // ensures p1 <= p2 <= 1

      const res1 = percentile(vals, p1);
      const res2 = percentile(vals, p2);

      expect(cmp(res1, res2)).toBeLessThanOrEqual(0);
    }
  });

  it("invariant 3: order-independent (shuffling input array does not change result)", () => {
    for (let i = 0; i < 200; i++) {
      const len = 2 + Math.floor(r() * 20);
      const vals = Array.from({ length: len }, () => randomRate(r));
      const p = r();

      const originalResult = percentile(vals, p);

      // Fisher-Yates shuffle
      const shuffled = [...vals];
      for (let j = shuffled.length - 1; j > 0; j--) {
        const k = Math.floor(r() * (j + 1));
        const temp = shuffled[j]!;
        shuffled[j] = shuffled[k]!;
        shuffled[k] = temp;
      }

      const shuffledResult = percentile(shuffled, p);
      expect(shuffledResult).toBe(originalResult);
    }
  });

  it("invariant 4: never produces float drift or scientific notation artifacts", () => {
    for (let i = 0; i < 300; i++) {
      const len = 1 + Math.floor(r() * 15);
      const vals = Array.from({ length: len }, () => randomRate(r));
      const p = r();

      const res = percentile(vals, p);
      expect(res).not.toContain("e");
      expect(res).not.toContain("E");
      expect(res).not.toContain("NaN");
      expect(res).toMatch(/^-?\d+(\.\d+)?$/);
    }
  });
});
