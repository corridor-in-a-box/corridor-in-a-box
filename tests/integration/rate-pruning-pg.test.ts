// Integration test for rate pruning and the daily summary guard against a REAL Postgres.
//
// Skipped unless CORRIDOR_TEST_DATABASE_URL is set (e.g. in CI or devcontainer).
//
// Locally:
//   docker run --rm -e POSTGRES_PASSWORD=pg -p 5432:5432 postgres:16
//   CORRIDOR_TEST_DATABASE_URL=postgres://postgres:pg@localhost:5432/postgres \
//     pnpm exec vitest run tests/integration/rate-pruning-pg.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DELETE_PRUNABLE_SAMPLES_SQL,
  SELECT_UNSUMMARIZED_DAYS_SQL,
  calculateRetentionCutoff,
  utcDayString,
  type Queryable,
} from "@corridor/engine";

const url = process.env.CORRIDOR_TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("Rate pruning & summary guard (live Postgres)", () => {
  let pool: { query: Queryable["query"]; end: () => Promise<void> };

  beforeAll(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: url }) as unknown as typeof pool;

    // Create real PostgreSQL rate tables
    await pool.query(`
      create table if not exists rate_samples (
        id            bigserial primary key,
        pair          text not null,
        sell_asset    text not null,
        buy_asset     text not null,
        source        text not null,
        anchor_domain text,
        rate          numeric not null,
        sampled_at    timestamptz not null,
        network       text not null,
        run_id        text,
        detail        jsonb
      );
    `);

    await pool.query(`
      create table if not exists rate_daily (
        id            bigserial primary key,
        pair          text not null,
        day           date not null,
        source        text not null,
        network       text not null,
        min_rate      numeric,
        p25_rate      numeric,
        median_rate   numeric,
        p75_rate      numeric,
        max_rate      numeric,
        sample_count  integer not null,
        created_at    timestamptz not null default now(),
        constraint rate_daily_pair_source_day_net unique (pair, source, day, network)
      );
    `);

    await pool.query(`
      create table if not exists rate_pruning_state (
        key             text primary key,
        last_pruned_day text not null,
        last_pruned_at  timestamptz not null,
        rows_deleted    integer not null default 0,
        batches         integer not null default 0
      );
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query("delete from rate_samples");
    await pool.query("delete from rate_daily");
    await pool.query("delete from rate_pruning_state");
  });

  it("executes the exact deletion query against real Postgres and enforces the guard", async () => {
    const now = Date.now();
    const cutoff = calculateRetentionCutoff(90, now);
    const oldDate = new Date(now - 100 * 86_400_000);
    const oldDayStr = utcDayString(oldDate);

    // Insert 2 raw samples on the same day: USDC/NGN and EUR/USD
    const resUsdc = await pool.query<{ id: string }>(
      `insert into rate_samples (pair, sell_asset, buy_asset, source, rate, sampled_at, network)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      ["USDC/NGN", "USDC", "NGN", "sep38_price", 1650.5, oldDate.toISOString(), "testnet"],
    );
    const resEur = await pool.query<{ id: string }>(
      `insert into rate_samples (pair, sell_asset, buy_asset, source, rate, sampled_at, network)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      ["EUR/USD", "EUR", "USD", "sep38_price", 1.08, oldDate.toISOString(), "testnet"],
    );

    const usdcId = resUsdc.rows[0].id;
    const eurId = resEur.rows[0].id;

    // Insert daily summary ONLY for USDC/NGN, NOT for EUR/USD
    await pool.query(
      `insert into rate_daily (pair, day, source, network, min_rate, p25_rate, median_rate, p75_rate, max_rate, sample_count)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      ["USDC/NGN", oldDayStr, "sep38_price", "testnet", 1650, 1650, 1650.5, 1651, 1652, 96],
    );

    // Verify unsummarized query on real Postgres identifies EUR/USD
    const unsummarized = await pool.query<{ unsummarized_day: Date; pair: string }>(
      SELECT_UNSUMMARIZED_DAYS_SQL,
      [cutoff],
    );
    expect(unsummarized.rows.length).toBe(1);
    expect(unsummarized.rows[0].pair).toBe("EUR/USD");

    // Execute DELETE_PRUNABLE_SAMPLES_SQL
    const deletedRes = await pool.query<{ id: string }>(DELETE_PRUNABLE_SAMPLES_SQL, [
      cutoff,
      1000,
    ]);

    expect(deletedRes.rows.length).toBe(1);
    expect(String(deletedRes.rows[0].id)).toBe(String(usdcId));

    // Verify in real Postgres: USDC/NGN was deleted, EUR/USD remains in rate_samples
    const remaining = await pool.query<{ id: string; pair: string }>(
      "select id, pair from rate_samples",
    );
    expect(remaining.rows.length).toBe(1);
    expect(String(remaining.rows[0].id)).toBe(String(eurId));
    expect(remaining.rows[0].pair).toBe("EUR/USD");

    // Verify rate_daily was never touched
    const summaries = await pool.query("select * from rate_daily");
    expect(summaries.rows.length).toBe(1);
  });
});
