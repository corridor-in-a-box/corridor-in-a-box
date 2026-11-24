import { describe, expect, it } from "vitest";
import {
  CREATE_RATE_SAMPLES_TABLE_SQL,
  RATE_SAMPLES_INDEX_SQL,
  PostgresRateHistoryStore,
  migrate,
  type Queryable,
  type RateSampleInput,
} from "@corridor/engine";

const USDC = "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function fakeDb(rows: Record<string, unknown>[] = []) {
  const calls: { text: string; params?: unknown[] }[] = [];
  const db: Queryable = {
    async query<R>(text: string, params?: unknown[]) {
      calls.push({ text, params });
      return { rows: rows as R[] };
    },
  };
  return { db, calls };
}

const sample = (over: Partial<RateSampleInput> = {}): RateSampleInput => ({
  sellAsset: USDC,
  buyAsset: "iso4217:BRL",
  source: "own_payment",
  anchorDomain: "ntokens.com",
  rate: "5.4512345678901234",
  sampledAt: 1700000000000,
  network: "public",
  runId: "run_test_123",
  detail: { note: "completed payment rate" },
  ...over,
});

describe("PostgresRateHistoryStore", () => {
  it("records the rate as the exact decimal string it was given, never a float", async () => {
    const { db, calls } = fakeDb();
    await new PostgresRateHistoryStore(db).record(sample());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toMatch(/insert into rate_samples/);
    expect(calls[0]!.params).toEqual([
      USDC,
      "iso4217:BRL",
      "own_payment",
      "ntokens.com",
      "5.4512345678901234",
      new Date(1700000000000).toISOString(),
      "public",
      "run_test_123",
      JSON.stringify({ note: "completed payment rate" }),
    ]);
  });

  it("stores null for the optional anchor, run and detail", async () => {
    const { db, calls } = fakeDb();
    await new PostgresRateHistoryStore(db).record({
      sellAsset: USDC,
      buyAsset: "iso4217:NGN",
      source: "dex_trade",
      rate: "1650.5000000",
      sampledAt: new Date("2026-11-19T12:00:00Z"),
      network: "testnet",
    });
    expect(calls[0]!.params?.[3]).toBeNull();
    expect(calls[0]!.params?.[7]).toBeNull();
    expect(calls[0]!.params?.[8]).toBeNull();
  });

  it.each([
    ["a JS number", 5.45 as unknown as string],
    ["an exponent", "5e2"],
    ["a negative rate", "-1.2"],
    ["a zero rate", "0.000"],
    ["an empty string", ""],
  ])("rejects %s as a rate without querying", async (_label, rate) => {
    const { db, calls } = fakeDb();
    await expect(new PostgresRateHistoryStore(db).record(sample({ rate }))).rejects.toThrow(
      RangeError,
    );
    expect(calls).toHaveLength(0);
  });

  it("rejects an unknown source and an invalid time", async () => {
    const { db, calls } = fakeDb();
    const store = new PostgresRateHistoryStore(db);
    await expect(
      store.record(sample({ source: "guess" as unknown as RateSampleInput["source"] })),
    ).rejects.toThrow(/source/);
    await expect(store.record(sample({ sampledAt: "not a date" }))).rejects.toThrow(
      /sampledAt/,
    );
    expect(calls).toHaveLength(0);
  });

  it("lists a window for one pair and network, newest first", async () => {
    const { db, calls } = fakeDb([
      {
        id: 1,
        sell_asset: USDC,
        buy_asset: "iso4217:BRL",
        source: "sep38_price",
        anchor_domain: "ntokens.com",
        rate: "5.5000000",
        sampled_at: new Date("2026-11-19T12:00:00Z"),
        network: "public",
        run_id: null,
        detail: null,
      },
    ]);

    const results = await new PostgresRateHistoryStore(db).list({
      sellAsset: USDC,
      buyAsset: "iso4217:BRL",
      network: "public",
      source: "sep38_price",
      since: 1700000000000,
      limit: 50,
    });

    expect(calls[0]!.text).toMatch(
      /where sell_asset = \$1 and buy_asset = \$2 and source = \$3 and network = \$4 and sampled_at >= \$5/,
    );
    expect(calls[0]!.text).toMatch(/order by sampled_at desc/);
    expect(calls[0]!.text).toMatch(/limit 50/);
    expect(results).toEqual([
      {
        id: "1",
        sellAsset: USDC,
        buyAsset: "iso4217:BRL",
        source: "sep38_price",
        anchorDomain: "ntokens.com",
        rate: "5.5000000",
        sampledAt: Date.parse("2026-11-19T12:00:00Z"),
        network: "public",
        runId: null,
        detail: null,
      },
    ]);
  });

  it("rejects a limit that is not a positive integer", async () => {
    const { db } = fakeDb();
    await expect(new PostgresRateHistoryStore(db).list({ limit: 0 })).rejects.toThrow(/limit/);
  });

  it("is created and indexed by migrate()", async () => {
    const { db, calls } = fakeDb();
    await migrate(db);
    const sqlCalls = calls.map((c) => c.text);
    expect(sqlCalls).toContain(CREATE_RATE_SAMPLES_TABLE_SQL);
    for (const indexSql of RATE_SAMPLES_INDEX_SQL) expect(sqlCalls).toContain(indexSql);
    // Rates are numeric in the schema, never a float type.
    expect(CREATE_RATE_SAMPLES_TABLE_SQL).toMatch(/rate\s+numeric not null/);
    expect(CREATE_RATE_SAMPLES_TABLE_SQL).not.toMatch(/real|double precision|float/);
  });
});
