import { describe, expect, it } from "vitest";
import {
  buildTradeAggregationsUrl,
  collectDexTrades,
  collectDexTradesForPair,
  DEX_TRADE_RESOLUTION_15M,
  formatDexAsset,
  loadDexPairsConfig,
  resolveAssetQueryParams,
  transformTradeAggregations,
  type DexPairConfig,
  type HorizonTradeAggregationRecord,
  type RateSampleRecord,
  type RateSampleSink,
} from "@corridor/engine";
import { join } from "node:path";

// Recorded fixture from real Horizon /trade_aggregations endpoint
const RECORDED_HORIZON_FIXTURE: HorizonTradeAggregationRecord[] = [
  {
    timestamp: "1700000000000",
    count: 14,
    opening: "0.1250000",
    high: "0.1265000",
    low: "0.1248000",
    close: "0.1260000",
    close_r: { n: 126, d: 1000 },
    base_volume: "5000.0000000",
    counter_volume: "630.0000000",
    avg: "0.1260000",
  },
  {
    // Empty bucket with 0 trades: must be skipped
    timestamp: "1700000900000",
    count: 0,
    opening: "0.1260000",
    high: "0.1260000",
    low: "0.1260000",
    close: "0.1260000",
    base_volume: "0.0000000",
    counter_volume: "0.0000000",
    avg: "0.0000000",
  },
  {
    timestamp: "1700001800000",
    count: "23", // Horizon sometimes returns count as string
    opening: "0.1260000",
    high: "0.1280000",
    low: "0.1255000",
    close: "0.1278500",
    close_r: { n: 12785, d: 100000 },
    base_volume: "12500.5000000",
    counter_volume: "1598.1889250",
    avg: "0.1278500",
  },
];

const MOCK_USDC_XLM_PAIR: DexPairConfig = {
  base: {
    code: "USDC",
    issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    type: "credit_alphanum4",
  },
  counter: {
    code: "XLM",
    type: "native",
  },
  network: "public",
};

describe("rate-collector-dex (#591)", () => {
  it("formats assets and query parameters correctly", () => {
    expect(formatDexAsset({ code: "XLM", type: "native" })).toBe("native");
    expect(
      formatDexAsset({
        code: "USDC",
        issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      }),
    ).toBe("USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");

    expect(resolveAssetQueryParams({ code: "XLM", type: "native" }, "counter")).toEqual({
      counter_asset_type: "native",
    });

    expect(
      resolveAssetQueryParams(
        {
          code: "USDC",
          issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        },
        "base",
      ),
    ).toEqual({
      base_asset_type: "credit_alphanum4",
      base_asset_code: "USDC",
      base_asset_issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    });
  });

  it("builds the trade_aggregations URL with 15-minute resolution (900000 ms)", () => {
    const url = buildTradeAggregationsUrl(MOCK_USDC_XLM_PAIR, {
      startTime: 1700000000000,
      endTime: 1700003600000,
      limit: 100,
      order: "asc",
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://horizon.stellar.org");
    expect(parsed.pathname).toBe("/trade_aggregations");
    expect(parsed.searchParams.get("base_asset_type")).toBe("credit_alphanum4");
    expect(parsed.searchParams.get("base_asset_code")).toBe("USDC");
    expect(parsed.searchParams.get("base_asset_issuer")).toBe(
      "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    );
    expect(parsed.searchParams.get("counter_asset_type")).toBe("native");
    expect(parsed.searchParams.get("resolution")).toBe("900000"); // 15-minute resolution in ms
    expect(DEX_TRADE_RESOLUTION_15M).toBe(900_000);
    expect(parsed.searchParams.get("start_time")).toBe("1700000000000");
    expect(parsed.searchParams.get("end_time")).toBe("1700003600000");
    expect(parsed.searchParams.get("limit")).toBe("100");
    expect(parsed.searchParams.get("order")).toBe("asc");
  });

  it("transforms recorded Horizon fixtures: skips zero-trade buckets and tags source=dex_trade", () => {
    const samples = transformTradeAggregations(RECORDED_HORIZON_FIXTURE, MOCK_USDC_XLM_PAIR);

    // Out of 3 records, 1 had 0 trades, so exactly 2 samples should be produced
    expect(samples).toHaveLength(2);

    const first = samples[0]!;
    expect(first.source).toBe("dex_trade");
    expect(first.pair).toBe(
      "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN:native",
    );
    expect(first.sellAsset).toBe(
      "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    );
    expect(first.buyAsset).toBe("native");
    expect(first.rate).toBe("0.1260000");
    expect(first.sampledAt).toBe(1700000000000);
    expect(first.network).toBe("public");
    expect(first.detail?.tradeCount).toBe(14);
    expect(first.detail?.baseVolume).toBe("5000.0000000");
    expect(first.detail?.counterVolume).toBe("630.0000000");

    const second = samples[1]!;
    expect(second.source).toBe("dex_trade");
    expect(second.rate).toBe("0.1278500");
    expect(second.sampledAt).toBe(1700001800000);
    expect(second.detail?.tradeCount).toBe(23);
  });

  it("collectDexTrades collects and records samples into sink", async () => {
    const recorded: RateSampleRecord[] = [];
    const mockSink: RateSampleSink = {
      async record(sample: RateSampleRecord) {
        recorded.push(sample);
      },
    };

    const mockFetch = async () =>
      new Response(JSON.stringify({ _embedded: { records: RECORDED_HORIZON_FIXTURE } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const samples = await collectDexTrades([MOCK_USDC_XLM_PAIR], mockSink, {
      fetch: mockFetch as unknown as typeof fetch,
    });

    expect(samples).toHaveLength(2);
    expect(recorded).toHaveLength(2);
    expect(recorded[0]!.source).toBe("dex_trade");
    expect(recorded[0]!.rate).toBe("0.1260000");
    expect(recorded[1]!.rate).toBe("0.1278500");

    // Also test single pair collector directly
    const pairSamples = await collectDexTradesForPair(MOCK_USDC_XLM_PAIR, undefined, {
      fetch: mockFetch as unknown as typeof fetch,
    });
    expect(pairSamples).toHaveLength(2);
  });

  it("loads configured pairs from config/dex-pairs.json", () => {
    const configPath = join(process.cwd(), "config", "dex-pairs.json");
    const pairs = loadDexPairsConfig(configPath);

    expect(pairs.length).toBeGreaterThanOrEqual(2);
    const usdcXlm = pairs.find((p) => p.base.code === "USDC" && p.counter.code === "XLM");
    expect(usdcXlm).toBeDefined();
    expect(usdcXlm?.base.issuer).toBeDefined();
  });
});
