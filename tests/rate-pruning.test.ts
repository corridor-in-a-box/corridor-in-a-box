// Rate history retention and pruning (#599). These tests check what pruneRateSamples and the
// collector step send to the database and how they react to its answers, with a fake Queryable.
// The guard itself is SQL, so tests/integration/rate-samples-pg.test.ts runs it against a real
// Postgres: a day with no summary keeps its samples there.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_PRUNE_BATCHES,
  DEFAULT_PRUNE_BATCH_SIZE,
  DEFAULT_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  PRUNE_RATE_SAMPLES_SQL,
  RateCollectorLoop,
  SELECT_UNSUMMARIZED_DAYS_SQL,
  calculateRetentionCutoff,
  createPruningCollectorStep,
  parseRetentionDays,
  pruneRateSamples,
  type Logger,
  type Queryable,
} from "@corridor/engine";

const NOW = Date.parse("2026-11-21T12:00:00.000Z");
const USDC = "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

/**
 * A fake database. Each prune batch answers with the next number in `deletes` (0 once they run
 * out); the blocked-days query answers with `blocked`.
 */
function fakeDb(deletes: number[] = [], blocked: Record<string, unknown>[] = []) {
  const calls: { text: string; params?: unknown[] }[] = [];
  const queue = [...deletes];
  const db: Queryable = {
    async query<R>(text: string, params?: unknown[]) {
      calls.push({ text, params });
      if (text === PRUNE_RATE_SAMPLES_SQL)
        return { rows: [{ deleted: queue.shift() ?? 0 }] as R[] };
      if (text === SELECT_UNSUMMARIZED_DAYS_SQL) return { rows: blocked as R[] };
      throw new Error(`unexpected query: ${text}`);
    },
  };
  const prunes = () => calls.filter((c) => c.text === PRUNE_RATE_SAMPLES_SQL);
  return { db, calls, prunes };
}

function recordingLogger() {
  const events: { level: string; event: string; fields?: Record<string, unknown> }[] = [];
  const logger: Logger = {
    log(level, event, fields) {
      events.push({ level, event, fields });
    },
  };
  return { logger, events };
}

const flat = (sql: string) => sql.replace(/\s+/g, " ");

describe("retention settings (#599)", () => {
  it("defaults to 90 days and enforces a 7-day floor", () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(90);
    expect(MIN_RETENTION_DAYS).toBe(7);
    expect(parseRetentionDays(undefined)).toBe(90);
    expect(parseRetentionDays(null)).toBe(90);
    expect(parseRetentionDays("")).toBe(90);
  });

  it("accepts whole numbers of days from 7 up, as strings or numbers", () => {
    expect(parseRetentionDays("7")).toBe(7);
    expect(parseRetentionDays(" 30 ")).toBe(30);
    expect(parseRetentionDays(365)).toBe(365);
  });

  it.each(["0", "6", "-30", "1.5", "90d", "abc", "1e3"])(
    "refuses %j with a clear error",
    (value) => {
      expect(() => parseRetentionDays(value)).toThrow(RangeError);
      expect(() => parseRetentionDays(value)).toThrow(/at least 7/);
    },
  );

  it.each([0, 6, -1, 7.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses the number %s",
    (n) => {
      expect(() => parseRetentionDays(n)).toThrow(RangeError);
    },
  );
});

describe("calculateRetentionCutoff", () => {
  it("is midnight UTC, retentionDays before the start of today", () => {
    expect(calculateRetentionCutoff(90, NOW).toISOString()).toBe("2026-08-23T00:00:00.000Z");
    expect(calculateRetentionCutoff(7, NOW).toISOString()).toBe("2026-11-14T00:00:00.000Z");
  });

  it("is the same all day long, so a day is never half-pruned", () => {
    const start = Date.parse("2026-11-21T00:00:00.000Z");
    const end = Date.parse("2026-11-21T23:59:59.999Z");
    expect(calculateRetentionCutoff(7, start)).toEqual(calculateRetentionCutoff(7, end));
    expect(calculateRetentionCutoff(7, end + 1).getTime()).toBe(
      calculateRetentionCutoff(7, end).getTime() + 86_400_000,
    );
  });

  it("always keeps at least the last 7 full days", () => {
    for (const at of [
      NOW,
      Date.parse("2026-01-01T00:00:00Z"),
      Date.parse("2026-03-01T23:59Z"),
    ]) {
      expect(at - calculateRetentionCutoff(7, at).getTime()).toBeGreaterThanOrEqual(
        7 * 86_400_000,
      );
    }
  });

  it("refuses a retention below 7 days", () => {
    expect(() => calculateRetentionCutoff(6, NOW)).toThrow(RangeError);
  });
});

describe("the prune query", () => {
  const sql = flat(PRUNE_RATE_SAMPLES_SQL);

  it("deletes only from rate_samples, never from rate_daily_summaries", () => {
    expect(sql).toMatch(/delete from rate_samples r/);
    expect(sql).not.toMatch(/delete from rate_daily_summaries/);
    expect(flat(SELECT_UNSUMMARIZED_DAYS_SQL)).not.toMatch(/delete/);
  });

  it("deletes only samples before the cutoff, oldest first, one batch at a time", () => {
    expect(sql).toContain("s.sampled_at < $1");
    expect(sql).toContain("order by s.sampled_at, s.id limit $2");
  });

  it("requires a summary for the sample's own series and UTC day, written after the sample", () => {
    const guard = sql.slice(sql.indexOf("exists ("));
    for (const clause of [
      "from rate_daily_summaries d",
      "d.network = s.network",
      "d.sell_asset = s.sell_asset",
      "d.buy_asset = s.buy_asset",
      "d.source = s.source",
      "d.anchor_domain is not distinct from s.anchor_domain",
      "d.day = (s.sampled_at at time zone 'UTC')::date",
      "d.computed_at >= s.recorded_at",
    ]) {
      expect(guard).toContain(clause);
    }
    expect(sql).not.toMatch(/not exists/);
  });

  it("reports exactly the samples the guard keeps", () => {
    const report = flat(SELECT_UNSUMMARIZED_DAYS_SQL);
    const guard = sql.slice(sql.indexOf("exists ("), sql.indexOf(") order by"));
    expect(report).toContain(`and not ${guard})`);
    expect(report).toContain("s.sampled_at < $1");
  });
});

describe("pruneRateSamples", () => {
  it("passes the cutoff and batch size, and stops at the first short batch", async () => {
    const { db, prunes } = fakeDb([1_000, 1_000, 250]);
    const result = await pruneRateSamples(db, { now: () => NOW });

    expect(prunes()).toHaveLength(3);
    for (const call of prunes()) {
      expect(call.params).toEqual(["2026-08-23T00:00:00.000Z", DEFAULT_PRUNE_BATCH_SIZE]);
    }
    expect(result).toMatchObject({
      day: "2026-11-21",
      cutoff: "2026-08-23T00:00:00.000Z",
      retentionDays: 90,
      rowsDeleted: 2_250,
      batches: 3,
      complete: true,
      blocked: [],
    });
  });

  it("runs one batch and reports nothing pruned when nothing is eligible", async () => {
    const { db, prunes } = fakeDb([]);
    const result = await pruneRateSamples(db, { now: () => NOW, retentionDays: 7 });
    expect(prunes()).toHaveLength(1);
    expect(prunes()[0]?.params?.[0]).toBe("2026-11-14T00:00:00.000Z");
    expect(result).toMatchObject({ rowsDeleted: 0, batches: 1, complete: true });
  });

  it("stops at maxBatches and says more remain", async () => {
    const { db, prunes } = fakeDb([10, 10, 10, 10]);
    const { logger, events } = recordingLogger();
    const result = await pruneRateSamples(db, {
      now: () => NOW,
      batchSize: 10,
      maxBatches: 2,
      logger,
    });
    expect(prunes()).toHaveLength(2);
    expect(result).toMatchObject({ rowsDeleted: 20, batches: 2, complete: false });
    expect(events.map((e) => e.event)).toContain("corridor.rate_pruning.batch_limit_reached");
  });

  it("defaults to 100 batches of 1,000 rows", async () => {
    const { db, prunes } = fakeDb(Array(200).fill(1_000));
    const result = await pruneRateSamples(db, { now: () => NOW });
    expect(DEFAULT_MAX_PRUNE_BATCHES).toBe(100);
    expect(prunes()).toHaveLength(100);
    expect(result.complete).toBe(false);
  });

  it("reports and logs the series-days the guard kept", async () => {
    const { db, calls } = fakeDb(
      [0],
      [
        {
          network: "public",
          sell_asset: USDC,
          buy_asset: "iso4217:BRL",
          source: "sep38_price",
          anchor_domain: "ntokens.com",
          day: "2026-08-01",
          samples: "96",
        },
      ],
    );
    const { logger, events } = recordingLogger();
    const result = await pruneRateSamples(db, {
      now: () => NOW,
      logger,
      blockedReportLimit: 5,
    });

    const report = calls.find((c) => c.text === SELECT_UNSUMMARIZED_DAYS_SQL);
    expect(report?.params).toEqual(["2026-08-23T00:00:00.000Z", 5]);
    expect(result.blocked).toEqual([
      {
        network: "public",
        sellAsset: USDC,
        buyAsset: "iso4217:BRL",
        source: "sep38_price",
        anchorDomain: "ntokens.com",
        day: "2026-08-01",
        samples: 96,
      },
    ]);
    const warn = events.find(
      (e) => e.event === "corridor.rate_pruning.unsummarized_days_skipped",
    );
    expect(warn?.level).toBe("warn");
    expect(warn?.fields?.blocked).toEqual(result.blocked);
  });

  it("issues no query at all for a retention below 7 days or a bad batch size", async () => {
    for (const options of [
      { retentionDays: 6 },
      { batchSize: 0 },
      { batchSize: 10_001 },
      { maxBatches: 0 },
      { batchSize: 1.5 },
    ]) {
      const { db, calls } = fakeDb();
      await expect(pruneRateSamples(db, { now: () => NOW, ...options })).rejects.toThrow(
        RangeError,
      );
      expect(calls).toHaveLength(0);
    }
  });

  it("lets a database error through", async () => {
    const db: Queryable = {
      async query() {
        throw new Error('relation "rate_samples" does not exist');
      },
    };
    await expect(pruneRateSamples(db, { now: () => NOW })).rejects.toThrow(/does not exist/);
  });
});

describe("createPruningCollectorStep", () => {
  it("prunes on the first tick of a UTC day and skips the rest of that day", async () => {
    let now = Date.parse("2026-11-21T00:05:00Z");
    const { db, prunes } = fakeDb([3, 0, 0]);
    const step = createPruningCollectorStep(db, { now: () => now });
    expect(step.name).toBe("rate_pruning");

    expect(await step.run()).toMatchObject({ pruned: 3, complete: true, batches: 1 });
    for (const t of ["2026-11-21T00:20:00Z", "2026-11-21T12:00:00Z", "2026-11-21T23:59:59Z"]) {
      now = Date.parse(t);
      expect(await step.run()).toMatchObject({ skipped: true, day: "2026-11-21" });
    }
    expect(prunes()).toHaveLength(1);

    now = Date.parse("2026-11-22T00:00:00Z");
    expect(await step.run()).toMatchObject({ pruned: 0, complete: true });
    expect(prunes()).toHaveLength(2);
    expect(prunes()[1]?.params?.[0]).toBe("2026-08-24T00:00:00.000Z");
  });

  it("carries on at the next tick when a run stopped at maxBatches", async () => {
    const { db, prunes } = fakeDb([5, 5, 2]);
    const step = createPruningCollectorStep(db, {
      now: () => NOW,
      batchSize: 5,
      maxBatches: 1,
    });
    expect(await step.run()).toMatchObject({ pruned: 5, complete: false });
    expect(await step.run()).toMatchObject({ pruned: 5, complete: false });
    expect(await step.run()).toMatchObject({ pruned: 2, complete: true });
    expect(await step.run()).toMatchObject({ skipped: true });
    expect(prunes()).toHaveLength(3);
  });

  it("retries on the next tick after a failure", async () => {
    let fail = true;
    const inner = fakeDb([1]);
    const db: Queryable = {
      query: (text, params) => {
        if (fail) return Promise.reject(new Error("connection reset"));
        return inner.db.query(text, params);
      },
    };
    const step = createPruningCollectorStep(db, { now: () => NOW });
    await expect(step.run()).rejects.toThrow("connection reset");
    fail = false;
    expect(await step.run()).toMatchObject({ pruned: 1, complete: true });
  });

  it("refuses a retention below 7 days when it is created, not on the first tick", () => {
    const { db } = fakeDb();
    expect(() => createPruningCollectorStep(db, { retentionDays: 3 })).toThrow(/at least 7/);
  });

  it("runs inside RateCollectorLoop as an ordinary step", async () => {
    const { db } = fakeDb([7]);
    const loop = new RateCollectorLoop({
      steps: [
        { name: "dex_trades", run: () => ({ collected: 4 }) },
        createPruningCollectorStep(db, { now: () => NOW }),
      ],
      maxJitterMs: 0,
      now: () => NOW,
    });
    const first = await loop.tick();
    expect(first.status).toBe("completed");
    expect(first.stepResults?.rate_pruning).toMatchObject({ pruned: 7, complete: true });
    const second = await loop.tick();
    expect(second.stepResults?.rate_pruning).toMatchObject({ skipped: true });
  });
});
