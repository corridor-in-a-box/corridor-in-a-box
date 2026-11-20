// Integration test for rate_samples schema and PostgresRateHistoryStore against REAL Postgres.
//
// Opt-in, like breaker-pg.test.ts and audit-pg.test.ts: skipped unless
// CORRIDOR_TEST_DATABASE_URL is set. CI provides a Postgres service container.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PostgresRateHistoryStore,
  migrate,
  type Queryable,
  type RateSampleRecord,
} from "@corridor/engine";

const url = process.env.CORRIDOR_TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("Postgres rate_samples schema and store (live Postgres)", () => {
  let pool: { query: Queryable["query"]; end: () => Promise<void> };

  beforeAll(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: url }) as unknown as typeof pool;
    await migrate(pool as unknown as Queryable);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query("delete from rate_samples");
  });

  const store = () => new PostgresRateHistoryStore(pool as unknown as Queryable);

  it("migrate() is idempotent and creates the rate_samples table and indices", async () => {
    // Re-running migrate() on an already migrated database must be an idempotent no-op
    await migrate(pool as unknown as Queryable);

    const tableRes = await pool.query(
      "select count(*)::int as n from information_schema.tables where table_name = $1",
      ["rate_samples"],
    );
    expect(tableRes.rows[0].n).toBe(1);

    // Verify column types: rate is numeric, sampled_at is timestamp with time zone
    const colRes = await pool.query(
      "select column_name, data_type from information_schema.columns where table_name = $1",
      ["rate_samples"],
    );
    const cols = Object.fromEntries(
      (colRes.rows as Array<{ column_name: string; data_type: string }>).map((r) => [
        r.column_name,
        r.data_type,
      ]),
    );
    expect(cols.rate).toBe("numeric");
    expect(cols.sampled_at).toBe("timestamp with time zone");
    expect(cols.pair).toBe("text");
    expect(cols.sell_asset).toBe("text");
    expect(cols.buy_asset).toBe("text");
    expect(cols.source).toBe("text");

    // Verify indices exist
    const idxRes = await pool.query("select indexname from pg_indexes where tablename = $1", [
      "rate_samples",
    ]);
    const indexNames = (idxRes.rows as Array<{ indexname: string }>).map((r) => r.indexname);
    expect(indexNames).toContain("rate_samples_pair_network_sampled_at_idx");
    expect(indexNames).toContain("rate_samples_assets_network_sampled_at_idx");
  });

  it("stores rates as exact numerics with no floating point loss", async () => {
    const s = store();
    // High-precision decimal that would suffer floating point representation errors in IEEE-754 float
    const preciseRate = "1650.1234567890123456";

    const sample: RateSampleRecord = {
      pair: "USDC:iso4217:NGN",
      sellAsset: "USDC",
      buyAsset: "iso4217:NGN",
      source: "own_payment",
      rate: preciseRate,
      sampledAt: new Date("2026-11-19T14:30:00Z"),
      network: "public",
      anchorDomain: "cowrie.exchange",
      runId: "run_precise_1",
    };

    await s.record(sample);

    const listed = await s.list({ pair: "USDC:iso4217:NGN" });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.rate).toBe(preciseRate);
    expect(listed[0]!.anchorDomain).toBe("cowrie.exchange");
  });

  it("supports window queries by pair, network, and time range", async () => {
    const s = store();
    const t0 = Date.parse("2026-11-19T10:00:00Z");

    // Insert samples over time
    for (let i = 0; i < 5; i++) {
      await s.record({
        pair: "USDC:iso4217:BRL",
        sellAsset: "USDC",
        buyAsset: "iso4217:BRL",
        source: "sep38_price",
        rate: `5.4${i}0000`,
        sampledAt: t0 + i * 3600 * 1000, // every hour
        network: "public",
      });
    }

    // Query window between hour 1 and hour 3
    const window = await s.list({
      pair: "USDC:iso4217:BRL",
      network: "public",
      since: t0 + 1 * 3600 * 1000,
      until: t0 + 3 * 3600 * 1000,
    });

    expect(window).toHaveLength(3);
    // Ordered descending by sampled_at
    expect(window.map((w) => w.rate)).toEqual(["5.430000", "5.420000", "5.410000"]);
  });
});
