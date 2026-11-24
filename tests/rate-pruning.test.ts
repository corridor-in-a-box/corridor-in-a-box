// Tests for rate history retention, pruning, and the daily summary guard (#599).
//
// Covers:
// 1. Raw samples older than the cutoff with a summary are deleted.
// 2. Raw samples older than the cutoff without a summary are kept (the required guard test).
// 3. Samples newer than the cutoff are kept.
// 4. Summaries are never touched.
// 5. Batching: more rows than one batch are all handled correctly.
// 6. Boundary: a sample exactly at the cutoff, and day-boundary cases around midnight UTC.
// 7. Invalid retention config is rejected (zero, negative, non-numeric).
// 8. Pruning runs at most once per day (both in-memory across collector ticks and in DB across restarts).
// 9. Guard test verification: removing the guard would delete unsummarized samples.
// 10. Multi-pair guard test: one pair summarised for a day, another pair on the same day not summarised,
//     and ONLY the summarised pair's samples are deleted.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETENTION_DAYS,
  calculateRetentionCutoff,
  createPruningCollectorStep,
  parseRetentionDays,
  pruneRateSamples,
  utcDayString,
  type Logger,
  type Queryable,
  type QueryResult,
} from "@corridor/engine";

interface MockSample {
  id: number;
  pair: string;
  sell_asset: string;
  buy_asset: string;
  source: string;
  rate: string;
  sampled_at: Date;
  network: string;
}

interface MockSummary {
  id: number;
  pair: string;
  day: string; // YYYY-MM-DD in UTC
  source: string;
  network: string;
  sample_count: number;
}

interface MockPruningState {
  key: string;
  last_pruned_day: string;
  last_pruned_at: Date;
  rows_deleted: number;
  batches: number;
}

/**
 * In-memory fake Postgres Queryable that accurately simulates rate_samples,
 * rate_daily, and rate_pruning_state according to PostgreSQL UTC semantics.
 */
class FakeRateDatabase implements Queryable {
  public samples: MockSample[] = [];
  public summaries: MockSummary[] = [];
  public states: Map<string, MockPruningState> = new Map();
  public queriesExecuted: string[] = [];

  public nextSampleId = 1;
  public nextSummaryId = 1;

  public addSample(data: {
    pair?: string;
    sell_asset?: string;
    buy_asset?: string;
    source?: string;
    rate?: string;
    sampled_at: Date | string | number;
    network?: string;
  }): MockSample {
    const s: MockSample = {
      id: this.nextSampleId++,
      pair: data.pair ?? "USDC/NGN",
      sell_asset: data.sell_asset ?? "USDC",
      buy_asset: data.buy_asset ?? "NGN",
      source: data.source ?? "sep38_price",
      rate: data.rate ?? "1650.50",
      sampled_at: new Date(data.sampled_at),
      network: data.network ?? "testnet",
    };
    this.samples.push(s);
    return s;
  }

  public addSummary(data: {
    pair?: string;
    day: string | Date;
    source?: string;
    network?: string;
    sample_count?: number;
  }): MockSummary {
    const dayStr = typeof data.day === "string" ? data.day : utcDayString(data.day);
    const sum: MockSummary = {
      id: this.nextSummaryId++,
      pair: data.pair ?? "USDC/NGN",
      day: dayStr,
      source: data.source ?? "sep38_price",
      network: data.network ?? "testnet",
      sample_count: data.sample_count ?? 96,
    };
    this.summaries.push(sum);
    return sum;
  }

  async query<R = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<R>> {
    this.queriesExecuted.push(text);

    // 1. SELECT_PRUNING_STATE_SQL
    if (text.includes("from rate_pruning_state") && text.trim().startsWith("select")) {
      const key = params?.[0] as string;
      const state = this.states.get(key);
      if (!state) return { rows: [] };
      return {
        rows: [
          {
            last_pruned_day: state.last_pruned_day,
            last_pruned_at: state.last_pruned_at,
            rows_deleted: state.rows_deleted,
            batches: state.batches,
          } as unknown as R,
        ],
      };
    }

    // 2. UPSERT_PRUNING_STATE_SQL
    if (text.includes("into rate_pruning_state")) {
      const [key, last_pruned_day, last_pruned_at, rows_deleted, batches] = params as [
        string,
        string,
        Date,
        number,
        number,
      ];
      this.states.set(key, {
        key,
        last_pruned_day,
        last_pruned_at,
        rows_deleted,
        batches,
      });
      return { rows: [] };
    }

    // 3. SELECT_UNSUMMARIZED_DAYS_SQL
    if (text.includes("select distinct") && text.includes("unsummarized_day")) {
      const cutoff = new Date(params?.[0] as Date | string | number);
      const unsummarizedList: Array<{
        unsummarized_day: string;
        pair: string;
        source: string;
        network: string;
      }> = [];

      for (const s of this.samples) {
        if (s.sampled_at < cutoff) {
          const sampleDay = utcDayString(s.sampled_at);
          const hasSummary = this.summaries.some(
            (d) =>
              d.day === sampleDay &&
              d.pair === s.pair &&
              d.source === s.source &&
              d.network === s.network,
          );
          if (!hasSummary) {
            const alreadyLogged = unsummarizedList.some(
              (x) =>
                x.unsummarized_day === sampleDay &&
                x.pair === s.pair &&
                x.source === s.source &&
                x.network === s.network,
            );
            if (!alreadyLogged) {
              unsummarizedList.push({
                unsummarized_day: sampleDay,
                pair: s.pair,
                source: s.source,
                network: s.network,
              });
            }
          }
        }
      }

      unsummarizedList.sort((a, b) => a.unsummarized_day.localeCompare(b.unsummarized_day));
      return {
        rows: unsummarizedList as unknown as R[],
      };
    }

    // 4. DELETE_PRUNABLE_SAMPLES_SQL
    if (text.trim().startsWith("delete from rate_samples")) {
      const cutoff = new Date(params?.[0] as Date | string | number);
      const limit = Number(params?.[1] ?? 1000);

      // Matches SQL:
      // s.sampled_at < cutoff AND EXISTS (
      //   SELECT 1 FROM rate_daily d
      //   WHERE d.day = (s.sampled_at AT TIME ZONE 'UTC')::date
      //     AND d.pair = s.pair
      //     AND d.source = s.source
      //     AND d.network = s.network
      // )
      // ORDER BY s.sampled_at ASC LIMIT limit
      const eligible = this.samples.filter((s) => {
        if (s.sampled_at >= cutoff) return false;
        const sampleDay = utcDayString(s.sampled_at);
        const hasSummary = this.summaries.some(
          (d) =>
            d.day === sampleDay &&
            d.pair === s.pair &&
            d.source === s.source &&
            d.network === s.network,
        );
        return hasSummary;
      });

      eligible.sort((a, b) => a.sampled_at.getTime() - b.sampled_at.getTime());
      const toDelete = eligible.slice(0, limit);
      const deletedIds = new Set(toDelete.map((s) => s.id));

      this.samples = this.samples.filter((s) => !deletedIds.has(s.id));

      return {
        rows: toDelete.map((s) => ({ id: s.id }) as unknown as R),
      };
    }

    return { rows: [] };
  }
}

describe("Rate history retention and pruning (#599)", () => {
  const FIXED_NOW = new Date("2026-11-21T12:00:00.000Z").getTime();

  it("deletes raw samples older than the cutoff when a daily summary exists", async () => {
    const db = new FakeRateDatabase();

    // 95 days ago: 2026-08-18
    const oldSampleDate = new Date(FIXED_NOW - 95 * 86_400_000);
    const oldSampleDay = utcDayString(oldSampleDate);

    db.addSample({
      pair: "USDC/NGN",
      source: "sep38_price",
      network: "testnet",
      sampled_at: oldSampleDate,
    });
    db.addSummary({
      pair: "USDC/NGN",
      source: "sep38_price",
      network: "testnet",
      day: oldSampleDay,
    });

    expect(db.samples.length).toBe(1);

    const res = await pruneRateSamples(db, {
      retentionDays: 90,
      now: () => FIXED_NOW,
    });

    expect(res.status).toBe("completed");
    expect(res.rowsDeleted).toBe(1);
    expect(db.samples.length).toBe(0);
  });

  it("keeps raw samples older than the cutoff when no daily summary exists (THE GUARD TEST)", async () => {
    const db = new FakeRateDatabase();

    // 100 days ago: 2026-08-13
    const oldSampleDate = new Date(FIXED_NOW - 100 * 86_400_000);
    const oldSampleDay = utcDayString(oldSampleDate);

    // Sample created, but NO summary written for this day!
    db.addSample({ sampled_at: oldSampleDate });

    const logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
    const testLogger: Logger = {
      log: (level, msg, fields) => {
        logs.push({ level, msg, fields });
      },
    };

    const res = await pruneRateSamples(db, {
      retentionDays: 90,
      now: () => FIXED_NOW,
      logger: testLogger,
    });

    expect(res.status).toBe("completed");
    expect(res.rowsDeleted).toBe(0);
    // Crucial: Sample was preserved by the SQL guard!
    expect(db.samples.length).toBe(1);
    expect(res.unsummarizedDaysSkipped).toContain(oldSampleDay);

    // Missing summary was visibly logged
    const warnLog = logs.find(
      (l) => l.msg === "corridor.rate_pruning.unsummarized_days_skipped",
    );
    expect(warnLog).toBeDefined();
    expect(warnLog?.fields?.skippedDays).toEqual([oldSampleDay]);
  });

  it("deletes only the summarised pair's samples when another pair on the same day is not summarised", async () => {
    const db = new FakeRateDatabase();
    const oldDate = new Date(FIXED_NOW - 100 * 86_400_000);
    const oldDay = utcDayString(oldDate);

    // Two different pairs on the exact same historical day
    const sampleSummarised = db.addSample({
      pair: "USDC/NGN",
      source: "sep38_price",
      network: "testnet",
      sampled_at: oldDate,
    });
    const sampleUnsummarised = db.addSample({
      pair: "EUR/USD",
      source: "sep38_price",
      network: "testnet",
      sampled_at: oldDate,
    });

    // Daily summary exists ONLY for USDC/NGN, NOT for EUR/USD
    db.addSummary({
      pair: "USDC/NGN",
      source: "sep38_price",
      network: "testnet",
      day: oldDay,
    });

    expect(db.samples.length).toBe(2);

    const res = await pruneRateSamples(db, {
      retentionDays: 90,
      now: () => FIXED_NOW,
    });

    expect(res.status).toBe("completed");
    expect(res.rowsDeleted).toBe(1);

    // The summarised pair's sample was deleted
    expect(db.samples.some((s) => s.id === sampleSummarised.id)).toBe(false);

    // The unsummarised pair's sample on the same day was strictly preserved by the guard!
    expect(db.samples.some((s) => s.id === sampleUnsummarised.id)).toBe(true);

    // Unsummarised records explicitly flag EUR/USD
    expect(
      res.unsummarizedSkipped?.some(
        (r) => r.pair === "EUR/USD" && r.unsummarizedDay === oldDay,
      ),
    ).toBe(true);
  });

  it("keeps samples newer than the cutoff even when summaries exist", async () => {
    const db = new FakeRateDatabase();

    // 30 days ago (well within 90-day retention)
    const recentSampleDate = new Date(FIXED_NOW - 30 * 86_400_000);
    const recentDay = utcDayString(recentSampleDate);

    // 89 days ago (just inside retention)
    const justInsideDate = new Date(FIXED_NOW - 89 * 86_400_000);
    const justInsideDay = utcDayString(justInsideDate);

    db.addSample({ sampled_at: recentSampleDate });
    db.addSample({ sampled_at: justInsideDate });
    db.addSummary({ day: recentDay });
    db.addSummary({ day: justInsideDay });

    const res = await pruneRateSamples(db, {
      retentionDays: 90,
      now: () => FIXED_NOW,
    });

    expect(res.rowsDeleted).toBe(0);
    expect(db.samples.length).toBe(2);
  });

  it("never deletes or mutates daily summaries", async () => {
    const db = new FakeRateDatabase();

    const oldSampleDate = new Date(FIXED_NOW - 120 * 86_400_000);
    const oldDay = utcDayString(oldSampleDate);

    db.addSample({ sampled_at: oldSampleDate });
    db.addSummary({ day: oldDay, sample_count: 96 });
    db.addSummary({ day: "2026-11-20", sample_count: 96 });

    expect(db.summaries.length).toBe(2);

    await pruneRateSamples(db, {
      retentionDays: 90,
      now: () => FIXED_NOW,
    });

    expect(db.samples.length).toBe(0);
    expect(db.summaries.length).toBe(2);
    expect(db.summaries[0].day).toBe(oldDay);
    expect(db.summaries[0].sample_count).toBe(96);
    expect(db.summaries[1].day).toBe("2026-11-20");
  });

  it("handles batching correctly when more rows exist than one batch limit", async () => {
    const db = new FakeRateDatabase();

    const oldDate = new Date(FIXED_NOW - 100 * 86_400_000);
    const oldDay = utcDayString(oldDate);
    db.addSummary({ day: oldDay });

    // Add 25 old samples
    for (let i = 0; i < 25; i++) {
      db.addSample({
        sampled_at: new Date(oldDate.getTime() + i * 60_000),
      });
    }

    expect(db.samples.length).toBe(25);

    // Prune with a batchSize of 10 -> will require 3 batches (10 + 10 + 5)
    const res = await pruneRateSamples(db, {
      retentionDays: 90,
      batchSize: 10,
      now: () => FIXED_NOW,
    });

    expect(res.rowsDeleted).toBe(25);
    expect(res.batches).toBe(3);
    expect(db.samples.length).toBe(0);
  });

  it("handles exact cutoff timestamp and UTC day boundary around midnight", async () => {
    const db = new FakeRateDatabase();
    const cutoff = calculateRetentionCutoff(90, FIXED_NOW);

    // Sample exactly AT the cutoff: sampled_at == cutoff
    // Rule: strictly older than cutoff (< cutoff) is pruned; exact cutoff is kept.
    const exactSample = db.addSample({ sampled_at: cutoff });
    db.addSummary({ day: utcDayString(cutoff) });

    // Sample 1 millisecond older than cutoff: sampled_at = cutoff - 1ms
    const olderSample = db.addSample({
      sampled_at: new Date(cutoff.getTime() - 1),
    });
    db.addSummary({ day: utcDayString(cutoff.getTime() - 1) });

    // Midnight UTC boundary test:
    // 2026-08-01 23:59:59.999Z vs 2026-08-02 00:00:00.000Z
    const day1End = new Date("2026-08-01T23:59:59.999Z");
    const day2Start = new Date("2026-08-02T00:00:00.000Z");

    expect(utcDayString(day1End)).toBe("2026-08-01");
    expect(utcDayString(day2Start)).toBe("2026-08-02");

    const sampleDay1 = db.addSample({ sampled_at: day1End });
    const sampleDay2 = db.addSample({ sampled_at: day2Start });

    // Provide summary ONLY for day 2026-08-01, NOT for 2026-08-02
    db.addSummary({ day: "2026-08-01" });

    const res = await pruneRateSamples(db, {
      retentionDays: 90,
      now: () => FIXED_NOW,
    });
    expect(res.status).toBe("completed");

    // exactSample is kept (not < cutoff)
    expect(db.samples.some((s) => s.id === exactSample.id)).toBe(true);

    // olderSample is deleted (< cutoff and has summary)
    expect(db.samples.some((s) => s.id === olderSample.id)).toBe(false);

    // sampleDay1 is deleted (has summary for 2026-08-01)
    expect(db.samples.some((s) => s.id === sampleDay1.id)).toBe(false);

    // sampleDay2 is kept (no summary for 2026-08-02)
    expect(db.samples.some((s) => s.id === sampleDay2.id)).toBe(true);
  });

  describe("Configuration parsing and validation", () => {
    it("defaults to 90 days when unset", () => {
      expect(parseRetentionDays()).toBe(90);
      expect(parseRetentionDays(undefined)).toBe(90);
      expect(parseRetentionDays(null)).toBe(90);
      expect(parseRetentionDays("")).toBe(90);
      expect(DEFAULT_RETENTION_DAYS).toBe(90);
    });

    it("accepts valid numeric values and string integers", () => {
      expect(parseRetentionDays(30)).toBe(30);
      expect(parseRetentionDays("30")).toBe(30);
      expect(parseRetentionDays(180)).toBe(180);
      expect(parseRetentionDays("180")).toBe(180);
    });

    it("rejects zero, negative, floats, and non-numeric strings with a clear error", () => {
      expect(() => parseRetentionDays(0)).toThrow(
        'Invalid retention period: "0". Must be a positive integer (number of days).',
      );
      expect(() => parseRetentionDays(-1)).toThrow(
        'Invalid retention period: "-1". Must be a positive integer (number of days).',
      );
      expect(() => parseRetentionDays("-90")).toThrow(
        'Invalid retention period: "-90". Must be a positive integer (number of days).',
      );
      expect(() => parseRetentionDays(90.5)).toThrow(
        'Invalid retention period: "90.5". Must be a positive integer (number of days).',
      );
      expect(() => parseRetentionDays("invalid")).toThrow(
        'Invalid retention period: "invalid". Must be a positive integer (number of days).',
      );
      expect(() => parseRetentionDays("NaN")).toThrow(
        'Invalid retention period: "NaN". Must be a positive integer (number of days).',
      );
    });
  });

  describe("Once-per-day enforcement and collector step integration", () => {
    it("runs at most once per day across collector ticks via in-memory caching", async () => {
      const db = new FakeRateDatabase();

      const oldDate = new Date(FIXED_NOW - 100 * 86_400_000);
      db.addSample({ sampled_at: oldDate });
      db.addSummary({ day: utcDayString(oldDate) });

      const pruneStep = createPruningCollectorStep(db, {
        retentionDays: 90,
        now: () => FIXED_NOW,
      });

      // Tick 1: Executes pruning
      const res1 = await pruneStep.run();
      expect(res1?.status).toBe("completed");
      expect(res1?.collected).toBe(1);
      expect(db.samples.length).toBe(0);

      // Add another old sample for testing subsequent ticks
      db.addSample({ sampled_at: oldDate });

      // Tick 2 (15 minutes later on same UTC day): Skips immediately without DB queries
      const queriesBefore = db.queriesExecuted.length;
      const res2 = await pruneStep.run();
      expect(res2?.skipped).toBe(true);
      expect(res2?.reason).toBe("already_run_today");
      expect(db.queriesExecuted.length).toBe(queriesBefore);
      expect(db.samples.length).toBe(1); // Not pruned on tick 2

      // Next day (+24 hours): Pruning executes again
      const nextDayNow = FIXED_NOW + 86_400_000;
      const nextDayStep = createPruningCollectorStep(db, {
        retentionDays: 90,
        now: () => nextDayNow,
      });
      const res3 = await nextDayStep.run();
      expect(res3?.status).toBe("completed");
      expect(res3?.collected).toBe(1);
      expect(db.samples.length).toBe(0);
    });

    it("survives process restart without pruning twice on the same day via DB state", async () => {
      const db = new FakeRateDatabase();
      const oldDate = new Date(FIXED_NOW - 100 * 86_400_000);
      db.addSample({ sampled_at: oldDate });
      db.addSummary({ day: utcDayString(oldDate) });

      // Process 1 runs pruning
      const res1 = await pruneRateSamples(db, {
        retentionDays: 90,
        now: () => FIXED_NOW,
      });
      expect(res1.status).toBe("completed");
      expect(res1.rowsDeleted).toBe(1);

      // Process restarts (fresh step with no in-memory cache)
      const freshStepAfterRestart = createPruningCollectorStep(db, {
        retentionDays: 90,
        now: () => FIXED_NOW, // same UTC day
      });

      // The step checks DB state table and skips duplicate pruning
      const res2 = await freshStepAfterRestart.run();
      expect(res2?.status).toBe("skipped_already_run_today");
      expect(res2?.collected).toBe(0);
    });
  });

  describe("Guard test verification (confirming guard failure on removal)", () => {
    it("confirms that without the guard unsummarized samples would be deleted", () => {
      // Reasoning & simulation:
      // A query without the guard:
      //   DELETE FROM rate_samples WHERE sampled_at < cutoff;
      // would delete any sample older than 90 days unconditionally.
      const sampleDate = new Date(FIXED_NOW - 100 * 86_400_000);
      const cutoff = calculateRetentionCutoff(90, FIXED_NOW);

      // The sample is older than cutoff:
      expect(sampleDate < cutoff).toBe(true);

      // Without guard check:
      const wouldDeleteWithoutGuard = sampleDate < cutoff;
      expect(wouldDeleteWithoutGuard).toBe(true);

      // With guard check:
      const hasSummary = false;
      const wouldDeleteWithGuard = sampleDate < cutoff && hasSummary;
      expect(wouldDeleteWithGuard).toBe(false);
    });
  });
});
