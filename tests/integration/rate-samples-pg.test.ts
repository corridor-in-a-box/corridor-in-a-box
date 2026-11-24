// Integration test for the rate_samples schema and PostgresRateHistoryStore against a REAL
// Postgres (#589).
//
// Opt-in, like audit-pg.test.ts and breaker-pg.test.ts: skipped unless
// CORRIDOR_TEST_DATABASE_URL is set. CI provides a Postgres service container
// (.github/workflows/ci.yml). Locally:
//
//   docker run --rm -e POSTGRES_PASSWORD=pg -p 5432:5432 postgres:16
//   CORRIDOR_TEST_DATABASE_URL=postgres://postgres:pg@localhost:5432/postgres \
//     pnpm exec vitest run tests/integration/rate-samples-pg.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresRateHistoryStore, migrate, type Queryable } from "@corridor/engine";

const url = process.env.CORRIDOR_TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

const USDC = "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

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

  it("migrate() is idempotent and leaves rate as numeric, sampled_at as timestamptz", async () => {
    await migrate(pool as unknown as Queryable);
    await migrate(pool as unknown as Queryable);

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
    expect(cols.sell_asset).toBe("text");
    expect(cols.buy_asset).toBe("text");
    expect(cols.source).toBe("text");

    const idxRes = await pool.query("select indexname from pg_indexes where tablename = $1", [
      "rate_samples",
    ]);
    expect((idxRes.rows as Array<{ indexname: string }>).map((r) => r.indexname)).toContain(
      "rate_samples_pair_network_sampled_at_idx",
    );
  });

  it("round-trips a high-precision rate exactly", async () => {
    const preciseRate = "1650.1234567890123456";
    await store().record({
      sellAsset: USDC,
      buyAsset: "iso4217:NGN",
      source: "own_payment",
      rate: preciseRate,
      sampledAt: new Date("2026-11-19T14:30:00Z"),
      network: "public",
      anchorDomain: "cowrie.exchange",
      runId: "run_precise_1",
    });

    const listed = await store().list({ sellAsset: USDC, buyAsset: "iso4217:NGN" });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.rate).toBe(preciseRate);
    expect(listed[0]!.anchorDomain).toBe("cowrie.exchange");
    expect(listed[0]!.sampledAt).toBe(Date.parse("2026-11-19T14:30:00Z"));
  });

  it("returns a window for one pair and network, newest first", async () => {
    const t0 = Date.parse("2026-11-19T10:00:00Z");
    for (let i = 0; i < 5; i++) {
      await store().record({
        sellAsset: USDC,
        buyAsset: "iso4217:BRL",
        source: "sep38_price",
        rate: `5.4${i}0000`,
        sampledAt: t0 + i * 3_600_000,
        network: "public",
      });
    }
    // Same pair on the other network: must not leak into the window.
    await store().record({
      sellAsset: USDC,
      buyAsset: "iso4217:BRL",
      source: "sep38_price",
      rate: "9.99",
      sampledAt: t0 + 2 * 3_600_000,
      network: "testnet",
    });

    const window = await store().list({
      sellAsset: USDC,
      buyAsset: "iso4217:BRL",
      network: "public",
      since: t0 + 3_600_000,
      until: t0 + 3 * 3_600_000,
    });
    expect(window.map((w) => w.rate)).toEqual(["5.430000", "5.420000", "5.410000"]);
  });

  it("refuses a non-positive rate and an unknown source at the database too", async () => {
    await expect(
      pool.query(
        "insert into rate_samples (sell_asset, buy_asset, source, rate, sampled_at, network) values ($1, $2, $3, $4, now(), $5)",
        [USDC, "iso4217:BRL", "sep38_price", "0", "public"],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        "insert into rate_samples (sell_asset, buy_asset, source, rate, sampled_at, network) values ($1, $2, $3, $4, now(), $5)",
        [USDC, "iso4217:BRL", "guess", "1", "public"],
      ),
    ).rejects.toThrow();
  });
});
