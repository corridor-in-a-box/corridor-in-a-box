import { describe, expect, it } from "vitest";
import {
  assessRateHistory,
  buildEstimatedOption,
  DEFAULT_ESTIMATE_WINDOW_DAYS,
  DEFAULT_MIN_ESTIMATE_SAMPLES,
  DEFAULT_MIN_ESTIMATE_SPAN_DAYS,
  type RateSample,
} from "@corridor/router";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

/** `count` samples evenly spread over the last 6 days (all inside the 7-day window), one rate. */
function inWindow(count: number, rate = "1500"): RateSample[] {
  if (count === 0) return [];
  if (count === 1) return [{ rate, timestampMs: NOW }];
  return Array.from({ length: count }, (_, i) => ({
    rate,
    timestampMs: NOW - 6 * DAY_MS + Math.round((6 * DAY_MS * i) / (count - 1)),
  }));
}

/** One sample `ageMs` before NOW: the oldest point of a history, setting how far back it reaches. */
function oldest(ageMs: number, rate = "1500"): RateSample {
  return { rate, timestampMs: NOW - ageMs };
}

/** A collector sample every 15 minutes from `firstMs` up to `lastMs`, inclusive. */
function every15Minutes(firstMs: number, lastMs: number, rate = "1500"): RateSample[] {
  const out: RateSample[] = [];
  for (let t = firstMs; t <= lastMs; t += 15 * MINUTE_MS) out.push({ rate, timestampMs: t });
  return out;
}

describe("assessRateHistory minimum-data rule (RFC 0004 §3)", () => {
  it("uses the router's one set of defaults: 100 samples in a 7-day window, 7 days of history", () => {
    expect(DEFAULT_MIN_ESTIMATE_SAMPLES).toBe(100);
    expect(DEFAULT_MIN_ESTIMATE_SPAN_DAYS).toBe(7);
    expect(DEFAULT_ESTIMATE_WINDOW_DAYS).toBe(7);
  });

  describe("sample-count threshold (history held at 8 days back)", () => {
    it("refuses just below 100 samples in the window", () => {
      expect(assessRateHistory([oldest(8 * DAY_MS), ...inWindow(99)], undefined, NOW)).toEqual(
        {
          ok: false,
          reason: "dropped: unpriceable (99 of 100 samples in 7d window)",
        },
      );
    });

    it("accepts exactly 100 samples in the window", () => {
      expect(
        assessRateHistory([oldest(8 * DAY_MS), ...inWindow(100)], undefined, NOW),
      ).toEqual({
        ok: true,
        p25: "1500",
        samples: 100,
      });
    });

    it("accepts just above 100 samples in the window", () => {
      expect(
        assessRateHistory([oldest(8 * DAY_MS), ...inWindow(101)], undefined, NOW),
      ).toEqual({
        ok: true,
        p25: "1500",
        samples: 101,
      });
    });

    it("does not count samples older than the window toward the 100", () => {
      const outside = Array.from({ length: 50 }, (_, i) => oldest(8 * DAY_MS + i * HOUR_MS));
      expect(assessRateHistory([...outside, ...inWindow(99)], undefined, NOW)).toEqual({
        ok: false,
        reason: "dropped: unpriceable (99 of 100 samples in 7d window)",
      });
    });

    it("refuses an empty history", () => {
      expect(assessRateHistory([], undefined, NOW)).toEqual({
        ok: false,
        reason: "dropped: unpriceable (0 of 100 samples in 7d window)",
      });
    });
  });

  describe("days-of-history threshold (120 samples held in the window)", () => {
    it("refuses a history reaching back just under 7 days", () => {
      const history = [oldest(7 * DAY_MS - HOUR_MS), ...inWindow(120)];
      expect(assessRateHistory(history, undefined, NOW)).toEqual({
        ok: false,
        reason: "dropped: unpriceable (history covers 6.9d of 7d needed)",
      });
    });

    it("accepts a history reaching back exactly 7 days", () => {
      // The oldest sample sits on the window's start, which is inclusive, so it counts too.
      const history = [oldest(7 * DAY_MS), ...inWindow(120)];
      expect(assessRateHistory(history, undefined, NOW)).toEqual({
        ok: true,
        p25: "1500",
        samples: 121,
      });
    });

    it("accepts a history reaching back just over 7 days", () => {
      // The oldest sample is 1 ms outside the window: it proves the depth but is not counted.
      const history = [oldest(7 * DAY_MS + 1), ...inWindow(120)];
      expect(assessRateHistory(history, undefined, NOW)).toEqual({
        ok: true,
        p25: "1500",
        samples: 120,
      });
    });

    it("reports a fractional span when the history is much shorter", () => {
      const history = Array.from({ length: 120 }, (_, i) => oldest(i * 5 * MINUTE_MS));
      expect(assessRateHistory(history, undefined, NOW)).toEqual({
        ok: false,
        reason: "dropped: unpriceable (history covers 0.4d of 7d needed)",
      });
    });
  });

  describe("a real 15-minute collector, at the defaults", () => {
    it("prices a series that does not start on the window edge", () => {
      // Collection began 7d 7m ago and the last run was 7 minutes ago, so no sample sits on
      // the window's start and the in-window samples span only 6d 23h 45m.
      const history = every15Minutes(NOW - 7 * DAY_MS - 7 * MINUTE_MS, NOW - 3 * MINUTE_MS);
      const inWindowTimes = history
        .map((s) => s.timestampMs)
        .filter((t) => t >= NOW - 7 * DAY_MS);
      expect(inWindowTimes.at(-1)! - inWindowTimes[0]!).toBe(7 * DAY_MS - 15 * MINUTE_MS);

      expect(assessRateHistory(history, undefined, NOW)).toEqual({
        ok: true,
        p25: "1500",
        samples: 672,
      });
    });

    it("prices a series that has been running for weeks", () => {
      const history = every15Minutes(NOW - 30 * DAY_MS + 11 * MINUTE_MS, NOW - 4 * MINUTE_MS);
      expect(assessRateHistory(history, undefined, NOW)).toEqual({
        ok: true,
        p25: "1500",
        samples: 672,
      });
    });

    it("refuses a collector that has only run for 6 days, plenty of samples or not", () => {
      const history = every15Minutes(NOW - 6 * DAY_MS + 2 * MINUTE_MS, NOW - 13 * MINUTE_MS);
      expect(history.length).toBeGreaterThan(500);
      expect(assessRateHistory(history, undefined, NOW)).toEqual({
        ok: false,
        reason: "dropped: unpriceable (history covers 5.9d of 7d needed)",
      });
    });
  });

  it("reports the sample count first when both thresholds fail", () => {
    expect(assessRateHistory(inWindow(50), undefined, NOW)).toEqual({
      ok: false,
      reason: "dropped: unpriceable (50 of 100 samples in 7d window)",
    });
  });

  describe("configurable thresholds", () => {
    const thresholds = { minSamples: 3, minDays: 2, windowDays: 1 };
    const threeInADay = [oldest(20 * HOUR_MS), oldest(10 * HOUR_MS), oldest(0)];

    it("accepts at both custom thresholds", () => {
      const history = [oldest(2 * DAY_MS), ...threeInADay];
      expect(assessRateHistory(history, thresholds, NOW)).toEqual({
        ok: true,
        p25: "1500",
        samples: 3,
      });
    });

    it("refuses below the custom sample threshold, counted in the custom window", () => {
      const history = [oldest(2 * DAY_MS), oldest(25 * HOUR_MS), ...threeInADay.slice(1)];
      expect(assessRateHistory(history, thresholds, NOW)).toEqual({
        ok: false,
        reason: "dropped: unpriceable (2 of 3 samples in 1d window)",
      });
    });

    it("refuses below the custom days threshold", () => {
      const history = [oldest(DAY_MS + 12 * HOUR_MS), ...threeInADay];
      expect(assessRateHistory(history, thresholds, NOW)).toEqual({
        ok: false,
        reason: "dropped: unpriceable (history covers 1.5d of 2d needed)",
      });
    });

    it("throws on a threshold out of range, like buildEstimatedOption", () => {
      expect(() => assessRateHistory(inWindow(100), { minSamples: 0 }, NOW)).toThrow(
        RangeError,
      );
      expect(() => assessRateHistory(inWindow(100), { minDays: -1 }, NOW)).toThrow(RangeError);
      expect(() => assessRateHistory(inWindow(100), { windowDays: 0 }, NOW)).toThrow(
        RangeError,
      );
    });
  });

  describe("the P25 it returns", () => {
    const small = { minSamples: 4, minDays: 0 };

    it("is the lower-method quartile of the observed rates", () => {
      const samples: RateSample[] = [
        { rate: "40", timestampMs: NOW - 3 * DAY_MS },
        { rate: "10", timestampMs: NOW - 2 * DAY_MS },
        { rate: "30", timestampMs: NOW - DAY_MS },
        { rate: "20", timestampMs: NOW },
      ];
      expect(assessRateHistory(samples, small, NOW)).toEqual({
        ok: true,
        p25: "10",
        samples: 4,
      });
    });

    it("picks the 25th of 100 rates, counting from the lowest", () => {
      const samples = [
        oldest(8 * DAY_MS),
        ...Array.from({ length: 100 }, (_, i) => ({
          rate: String(100 - i),
          timestampMs: NOW - i * HOUR_MS,
        })),
      ];
      expect(assessRateHistory(samples, undefined, NOW)).toEqual({
        ok: true,
        p25: "25",
        samples: 100,
      });
    });

    it("returns an observed rate in canonical form", () => {
      const samples = [oldest(8 * DAY_MS, "1512.3400"), ...inWindow(100, "1512.3400")];
      expect(assessRateHistory(samples, undefined, NOW)).toEqual({
        ok: true,
        p25: "1512.34",
        samples: 100,
      });
    });

    it("orders rates by exact decimal value, not float64", () => {
      const samples: RateSample[] = [
        { rate: "1.0000000000000002", timestampMs: NOW - 3 * DAY_MS },
        { rate: "1.0000000000000001", timestampMs: NOW - 2 * DAY_MS },
        { rate: "3", timestampMs: NOW - DAY_MS },
        { rate: "4", timestampMs: NOW },
      ];
      // float64 cannot tell the first two apart; the lower one is the P25.
      expect(assessRateHistory(samples, small, NOW)).toEqual({
        ok: true,
        p25: "1.0000000000000001",
        samples: 4,
      });
    });

    it("does not mutate or reorder the caller's samples", () => {
      const samples: RateSample[] = [
        { rate: "9", timestampMs: NOW - DAY_MS },
        { rate: "1", timestampMs: NOW - 3 * DAY_MS },
        { rate: "5", timestampMs: NOW },
        { rate: "3", timestampMs: NOW - 2 * DAY_MS },
      ];
      assessRateHistory(samples, small, NOW);
      expect(samples.map((s) => s.rate)).toEqual(["9", "1", "5", "3"]);
    });

    it("agrees with buildEstimatedOption on the same history", () => {
      const samples = [
        oldest(9 * DAY_MS, "1490"),
        ...inWindow(140).map((s, i) => ({ ...s, rate: `${1480 + (i % 37)}.${i % 10}` })),
      ];
      const assessed = assessRateHistory(samples, undefined, NOW);
      const option = buildEstimatedOption({
        receivingDomain: "anchor.example",
        sourceAmount: { asset: "USDC", amount: "250" },
        destAsset: "iso4217:NGN",
        history: samples,
        nowMs: NOW,
      });
      expect(option.status).toBe("offered");
      if (option.status !== "offered") return;
      expect(assessed).toEqual({
        ok: true,
        p25: option.price.p25Rate,
        samples: option.price.sampleCount,
      });
    });
  });

  describe("unusable samples are left out, never priced", () => {
    it("does not count a non-decimal rate", () => {
      const samples = [oldest(8 * DAY_MS), ...inWindow(100)];
      samples[42] = { rate: "not-a-rate", timestampMs: NOW - HOUR_MS };
      expect(assessRateHistory(samples, undefined, NOW)).toEqual({
        ok: false,
        reason: "dropped: unpriceable (99 of 100 samples in 7d window)",
      });
    });

    it("does not count a zero or negative rate: neither is a price", () => {
      for (const rate of ["0", "-1500"]) {
        const samples = [oldest(8 * DAY_MS), ...inWindow(100)];
        samples[1] = { rate, timestampMs: samples[1]!.timestampMs };
        expect(assessRateHistory(samples, undefined, NOW)).toEqual({
          ok: false,
          reason: "dropped: unpriceable (99 of 100 samples in 7d window)",
        });
      }
    });

    it("does not let a bad rate become the P25", () => {
      const samples = [oldest(8 * DAY_MS), ...inWindow(101)];
      samples[1] = { rate: "0", timestampMs: samples[1]!.timestampMs };
      expect(assessRateHistory(samples, undefined, NOW)).toEqual({
        ok: true,
        p25: "1500",
        samples: 100,
      });
    });

    it("does not count an outlier-flagged sample (#602), nor let it extend the history", () => {
      const flaggedOld = { ...oldest(8 * DAY_MS), outlier: true };
      expect(assessRateHistory([flaggedOld, ...inWindow(120)], undefined, NOW)).toEqual({
        ok: false,
        reason: "dropped: unpriceable (history covers 6.0d of 7d needed)",
      });
    });

    it("does not count a sample from the future", () => {
      const samples = [oldest(8 * DAY_MS), ...inWindow(99), oldest(-HOUR_MS)];
      expect(assessRateHistory(samples, undefined, NOW)).toEqual({
        ok: false,
        reason: "dropped: unpriceable (99 of 100 samples in 7d window)",
      });
    });
  });
});
