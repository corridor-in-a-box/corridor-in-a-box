// Outlier flagging for rate history (#602): the exact detector, the store calls a collector
// uses, and the estimate leaving flagged samples out of P25 while they stay in the data.

import { describe, expect, it } from "vitest";
import {
  checkOutlier,
  flagOutliers,
  medianRate,
  PostgresRateHistoryStore,
  DEFAULT_OUTLIER_THRESHOLD_BPS,
  type Queryable,
  type RateSampleInput,
} from "@corridor/engine";
import { buildEstimatedOption, type RateSample } from "@corridor/router";

const USDC = "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

describe("medianRate", () => {
  it("is exact for odd and even counts, with no float rounding", () => {
    expect(medianRate(["3", "1", "2"])).toBe("2");
    expect(medianRate(["1600", "1601"])).toBe("1600.5");
    // 0.1 + 0.2 is the classic float trap; the midpoint here is exactly 0.15.
    expect(medianRate(["0.1", "0.2"])).toBe("0.15");
    expect(medianRate(["1.0000001", "1.0000002"])).toBe("1.00000015");
    expect(medianRate(["5.4512345678901234", "5.4512345678901236"])).toBe(
      "5.4512345678901235",
    );
  });

  it("refuses an empty list or a rate that is not a positive decimal string", () => {
    expect(() => medianRate([])).toThrow(RangeError);
    expect(() => medianRate(["1", "-2"])).toThrow(RangeError);
    expect(() => medianRate(["1", "0"])).toThrow(RangeError);
    expect(() => medianRate(["1e3"])).toThrow(RangeError);
  });
});

describe("checkOutlier", () => {
  const recent = ["1000", "1000", "1000"];

  it("defaults to a 10% threshold, and exactly 10% is not an outlier", () => {
    expect(DEFAULT_OUTLIER_THRESHOLD_BPS).toBe(1_000);
    expect(checkOutlier("1100", recent)).toEqual({
      outlier: false,
      median: "1000",
      deviationBps: 1_000,
      baselineSize: 3,
    });
    expect(checkOutlier("900", recent).outlier).toBe(false);
    expect(checkOutlier("1100.0000001", recent).outlier).toBe(true);
    expect(checkOutlier("899.9999999", recent).outlier).toBe(true);
    expect(checkOutlier("2400", recent)).toMatchObject({
      outlier: true,
      deviationBps: 14_000,
    });
  });

  it("takes a configurable threshold in basis points", () => {
    expect(checkOutlier("1060", recent, { thresholdBps: 500 }).outlier).toBe(true);
    expect(checkOutlier("1030", recent, { thresholdBps: 500 }).outlier).toBe(false);
    expect(checkOutlier("1150", recent, { thresholdBps: 2_000 }).outlier).toBe(false);
    expect(checkOutlier("1250", recent, { thresholdBps: 2_000 }).outlier).toBe(true);
  });

  it("flags nothing until there is a baseline", () => {
    expect(checkOutlier("99999", ["1", "1"])).toEqual({
      outlier: false,
      median: null,
      deviationBps: null,
      baselineSize: 2,
    });
    expect(checkOutlier("99999", [], { minBaselineSamples: 1, windowSize: 1 }).outlier).toBe(
      false,
    );
  });

  it("uses only the last windowSize earlier rates", () => {
    // The old 50s fall outside a window of 3, so 101 is close to the median of 100.
    expect(
      checkOutlier("101", ["50", "50", "50", "100", "100", "100"], { windowSize: 3 }),
    ).toMatchObject({ outlier: false, median: "100", baselineSize: 3 });
  });

  it("rejects a bad policy or rate instead of guessing", () => {
    expect(() => checkOutlier("1", recent, { thresholdBps: 0 })).toThrow(RangeError);
    expect(() => checkOutlier("1", recent, { thresholdBps: 0.1 })).toThrow(RangeError);
    expect(() => checkOutlier("1", recent, { windowSize: 2, minBaselineSamples: 3 })).toThrow(
      RangeError,
    );
    expect(() => checkOutlier("NaN", recent)).toThrow(RangeError);
    expect(() => checkOutlier("1", ["1", "x", "1"])).toThrow(RangeError);
  });
});

describe("flagOutliers", () => {
  const t0 = Date.UTC(2026, 10, 19, 10, 0, 0);
  const at = (i: number) => t0 + i * 15 * 60_000;

  it("flags a spike and a drop, keeps every sample, and keeps input order", () => {
    const rates = ["1600", "1605", "1595", "2400", "800", "1602"];
    const samples = rates.map((rate, i) => ({ id: String(i), rate, sampledAt: at(i) }));
    const flagged = flagOutliers([...samples].reverse());
    expect(flagged).toHaveLength(6);
    expect(flagged.map((s) => s.id)).toEqual(["5", "4", "3", "2", "1", "0"]);
    expect(flagged.map((s) => s.outlier)).toEqual([false, true, true, false, false, false]);
    // The input objects are not mutated.
    expect("outlier" in samples[3]!).toBe(false);
  });

  it("stops flagging a lasting move once it fills half the window", () => {
    // A devaluation from 1000 to 1500 that stays. With a window of 4 the first three new-level
    // samples are flagged; once they are more than half the window the median has moved and
    // the fourth is accepted, as is everything after it.
    const rates = ["1000", "1000", "1000", "1000", "1500", "1500", "1500", "1500", "1500"];
    const flagged = flagOutliers(
      rates.map((rate, i) => ({ rate, sampledAt: at(i) })),
      { windowSize: 4 },
    );
    expect(flagged.map((s) => s.outlier)).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      false,
      false,
    ]);
  });
});

function sample(over: Partial<RateSampleInput> = {}): RateSampleInput {
  return {
    network: "public",
    sellAsset: USDC,
    buyAsset: "iso4217:NGN",
    source: "sep38_price",
    anchorDomain: "anchor.example",
    rate: "1600.5",
    sampledAt: Date.UTC(2026, 10, 19, 12, 0, 0),
    ...over,
  };
}

/** A fake database that answers the list query with `earlier` rows and the insert with an id. */
function scriptedDb(earlier: { rate: string; sampled_at: string }[]) {
  const calls: { text: string; params?: unknown[] }[] = [];
  const db: Queryable = {
    async query<R>(text: string, params?: unknown[]) {
      calls.push({ text, params });
      if (/^\s*select/.test(text)) {
        return {
          rows: earlier.map((r, i) => ({
            id: String(i + 1),
            network: "public",
            sell_asset: USDC,
            buy_asset: "iso4217:NGN",
            source: "sep38_price",
            anchor_domain: "anchor.example",
            rate: r.rate,
            sampled_at: r.sampled_at,
            run_id: null,
            outlier: false,
            detail: null,
          })) as R[],
        };
      }
      if (/^\s*update/.test(text))
        return { rows: (params?.[0] === "7" ? [{ id: "7" }] : []) as R[] };
      return { rows: [{ id: "99" }] as R[] };
    },
  };
  return { db, calls };
}

describe("PostgresRateHistoryStore.recordFlaggingOutliers", () => {
  const newestFirst = [
    { rate: "1601", sampled_at: "2026-11-19T11:45:00.000Z" },
    { rate: "1600", sampled_at: "2026-11-19T11:30:00.000Z" },
    { rate: "1599", sampled_at: "2026-11-19T11:15:00.000Z" },
  ];

  it("reads the series' earlier samples and stores a spike with outlier = true", async () => {
    const { db, calls } = scriptedDb(newestFirst);
    const result = await new PostgresRateHistoryStore(db).recordFlaggingOutliers(
      sample({ rate: "2400" }),
    );
    expect(result.stored).toBe(true);
    expect(result.verdict).toMatchObject({ outlier: true, median: "1600", baselineSize: 3 });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.text).toMatch(/from rate_samples/);
    expect(calls[0]!.text).toMatch(/limit 21/);
    expect(calls[0]!.params).toEqual([
      "public",
      USDC,
      "iso4217:NGN",
      "sep38_price",
      "anchor.example",
      new Date(Date.UTC(2026, 10, 19, 12, 0, 0)).toISOString(),
    ]);
    expect(calls[1]!.text).toMatch(/insert into rate_samples/);
    // The rate is stored as the exact string; the outlier column is the 9th parameter.
    expect(calls[1]!.params![5]).toBe("2400");
    expect(calls[1]!.params![8]).toBe(true);
  });

  it("stores an ordinary sample with outlier = false", async () => {
    const { db, calls } = scriptedDb(newestFirst);
    const result = await new PostgresRateHistoryStore(db).recordFlaggingOutliers(sample(), {
      thresholdBps: 500,
    });
    expect(result.verdict.outlier).toBe(false);
    expect(calls[1]!.params![8]).toBe(false);
  });

  it("ignores a stored sample at the same instant when building the baseline", async () => {
    const { db } = scriptedDb([
      { rate: "9999", sampled_at: "2026-11-19T12:00:00.000Z" },
      ...newestFirst,
    ]);
    const result = await new PostgresRateHistoryStore(db).recordFlaggingOutliers(sample());
    expect(result.verdict).toMatchObject({ median: "1600", baselineSize: 3 });
  });

  it("refuses an invalid sample before querying", async () => {
    const { db, calls } = scriptedDb(newestFirst);
    await expect(
      new PostgresRateHistoryStore(db).recordFlaggingOutliers(sample({ rate: "1,600" })),
    ).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});

describe("PostgresRateHistoryStore.setOutlier", () => {
  it("updates only the flag, by id, and reports whether the sample exists", async () => {
    const { db, calls } = scriptedDb([]);
    const store = new PostgresRateHistoryStore(db);
    expect(await store.setOutlier("7", true)).toBe(true);
    expect(calls[0]!.text).toMatch(/update rate_samples set outlier = \$2 where id = \$1/);
    expect(calls[0]!.params).toEqual(["7", true]);
    expect(await store.setOutlier("8", false)).toBe(false);
    await expect(store.setOutlier("1; drop table rate_samples", true)).rejects.toThrow(
      RangeError,
    );
  });
});

describe("estimated price leaves flagged outliers out of P25 (#602)", () => {
  const nowMs = Date.UTC(2026, 10, 20, 9, 0, 0);
  // 200 samples over 7 days: 50 at 99, 150 at 100. P25 index floor(0.25 * 199) = 49 -> 99.
  const clean: RateSample[] = Array.from({ length: 200 }, (_, i) => ({
    rate: i < 50 ? "99" : "100",
    timestampMs: nowMs - Math.round((i * 7 * 86_400_000) / 199),
  }));
  // 80 bad samples that would drag P25 to 10 if they were counted.
  const flagged: RateSample[] = Array.from({ length: 80 }, (_, i) => ({
    rate: "10",
    timestampMs: nowMs - (i + 1) * 3_600_000,
    outlier: true,
  }));
  const request = {
    receivingDomain: "anchor.example",
    sourceAmount: { asset: "USDC", amount: "100" },
    destAsset: "NGN",
    nowMs,
  };

  it("computes the same P25 with or without the flagged samples in the history", () => {
    const withOutliers = buildEstimatedOption({ ...request, history: [...clean, ...flagged] });
    const withoutOutliers = buildEstimatedOption({ ...request, history: clean });
    expect(withOutliers).toEqual(withoutOutliers);
    expect(withOutliers.status).toBe("offered");
    if (withOutliers.status !== "offered") throw new Error("expected offered");
    expect(withOutliers.price.p25Rate).toBe("99");
    expect(withOutliers.price.sampleCount).toBe(200);
  });

  it("would have been dragged down by the same samples unflagged", () => {
    const unflagged = flagged.map(({ rate, timestampMs }) => ({ rate, timestampMs }));
    const polluted = buildEstimatedOption({ ...request, history: [...clean, ...unflagged] });
    if (polluted.status !== "offered") throw new Error("expected offered");
    expect(polluted.price.p25Rate).toBe("10");
  });

  it("does not count flagged samples toward the minimum", () => {
    const outcome = buildEstimatedOption({
      ...request,
      history: [...clean.slice(0, 90), ...flagged],
    });
    expect(outcome).toMatchObject({ status: "dropped", sampleCount: 90 });
  });
});
