import { describe, expect, it } from "vitest";
import {
  CREATE_RATE_SAMPLES_TABLE_SQL,
  RATE_SAMPLES_INDEX_SQL,
  PostgresRateHistoryStore,
  migrate,
  type Queryable,
  type RateSampleRecord,
} from "@corridor/engine";

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

describe("PostgresRateHistoryStore", () => {
  it("records rate sample with numeric rate string (never float)", async () => {
    const { db, calls } = fakeDb();
    const store = new PostgresRateHistoryStore(db);

    const sample: RateSampleRecord = {
      pair: "USDC:iso4217:BRL",
      sellAsset: "USDC",
      buyAsset: "iso4217:BRL",
      source: "own_payment",
      anchorDomain: "ntokens.com",
      rate: "5.4512345678901234",
      sampledAt: 1700000000000,
      network: "public",
      runId: "run_test_123",
      detail: { note: "completed payment rate" },
    };

    await store.record(sample);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toMatch(/insert into rate_samples/);
    expect(calls[0]!.params).toEqual([
      "USDC:iso4217:BRL",
      "USDC",
      "iso4217:BRL",
      "own_payment",
      "ntokens.com",
      "5.4512345678901234", // Preserved as exact decimal string, never converted to float
      new Date(1700000000000).toISOString(),
      "public",
      "run_test_123",
      JSON.stringify({ note: "completed payment rate" }),
    ]);
  });

  it("infers pair from sellAsset and buyAsset if omitted", async () => {
    const { db, calls } = fakeDb();
    const store = new PostgresRateHistoryStore(db);

    await store.record({
      sellAsset: "USDC",
      buyAsset: "iso4217:NGN",
      source: "sep38_price",
      rate: "1650.5000000",
      sampledAt: new Date("2026-11-19T12:00:00Z"),
      network: "testnet",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.params?.[0]).toBe("USDC:iso4217:NGN");
    expect(calls[0]!.params?.[4]).toBeNull(); // anchorDomain
    expect(calls[0]!.params?.[8]).toBeNull(); // runId
    expect(calls[0]!.params?.[9]).toBeNull(); // detail
  });

  it("lists rate samples filtering by pair, network, source, and window", async () => {
    const mockRows = [
      {
        id: "1",
        pair: "USDC:iso4217:BRL",
        sell_asset: "USDC",
        buy_asset: "iso4217:BRL",
        source: "sep38_price",
        anchor_domain: "ntokens.com",
        rate: "5.5000000",
        sampled_at: new Date("2026-11-19T12:00:00Z"),
        network: "public",
        run_id: null,
        detail: null,
      },
    ];

    const { db, calls } = fakeDb(mockRows);
    const store = new PostgresRateHistoryStore(db);

    const results = await store.list({
      pair: "USDC:iso4217:BRL",
      network: "public",
      source: "sep38_price",
      since: 1700000000000,
      limit: 50,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toMatch(
      /where pair = \$1 and source = \$2 and network = \$3 and sampled_at >= \$4/,
    );
    expect(calls[0]!.text).toMatch(/order by sampled_at desc/);
    expect(calls[0]!.text).toMatch(/limit 50/);
    expect(results).toHaveLength(1);
    expect(results[0]!.rate).toBe("5.5000000");
  });

  it("is created and indexed by migrate()", async () => {
    const { db, calls } = fakeDb();
    await migrate(db);
    const sqlCalls = calls.map((c) => c.text);
    expect(sqlCalls).toContain(CREATE_RATE_SAMPLES_TABLE_SQL);
    for (const indexSql of RATE_SAMPLES_INDEX_SQL) {
      expect(sqlCalls).toContain(indexSql);
    }
  });
});
