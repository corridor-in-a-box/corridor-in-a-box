// DEX trade collector (#591). The Horizon responses under tests/fixtures/ were
// recorded from https://horizon.stellar.org/trade_aggregations on 2026-11-25
// (the request URL is in each file's `_links.self`).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTradeAggregationsUrl,
  collectDexTrades,
  collectDexTradesForPair,
  DEX_TRADE_RESOLUTION_15M,
  loadDexPairsConfig,
  parseDexPairsConfig,
  PostgresRateHistoryStore,
  tradeAggregationsToSamples,
  type DexPairConfig,
  type HorizonTradeAggregationsResponse,
  type Queryable,
} from "@corridor/engine";
import { loadCorridor } from "@corridor/manifest";

const USDC = "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ZARZ = "stellar:ZARZ:GAROH4EV3WVVTRQKEY43GZK3XSRBEYETRVZ7SVG5LHWOAANSMCTJBB3U";

const USDC_XLM: DexPairConfig = { network: "public", base: USDC, counter: "stellar:native" };
const ZARZ_USDC: DexPairConfig = { network: "public", base: ZARZ, counter: USDC };

function fixture(name: string): HorizonTradeAggregationsResponse {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), "tests/fixtures", `horizon-trade-aggregations-${name}.json`),
      "utf8",
    ),
  ) as HorizonTradeAggregationsResponse;
}

/** A fetch that answers from recorded fixtures and remembers the URLs it was asked for. */
function horizonStub(byBase: Record<string, HorizonTradeAggregationsResponse>) {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    const body = byBase[url.searchParams.get("base_asset_code") ?? "native"];
    if (!body) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/hal+json" },
    });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

/** The real store over a fake database: every sample goes through its validation. */
function recordingStore() {
  const inserts: unknown[][] = [];
  const db: Queryable = {
    async query<R>(_text: string, params?: unknown[]) {
      inserts.push(params ?? []);
      return { rows: [{ id: String(inserts.length) }] as R[] };
    },
  };
  return { store: new PostgresRateHistoryStore(db), inserts };
}

describe("buildTradeAggregationsUrl (#591)", () => {
  it("asks Horizon for 15-minute buckets of the pair, oldest first", () => {
    const url = new URL(
      buildTradeAggregationsUrl(ZARZ_USDC, {
        startTime: 1795530600000,
        endTime: new Date(1795620600000),
      }),
    );
    expect(url.origin + url.pathname).toBe("https://horizon.stellar.org/trade_aggregations");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      base_asset_type: "credit_alphanum4",
      base_asset_code: "ZARZ",
      base_asset_issuer: "GAROH4EV3WVVTRQKEY43GZK3XSRBEYETRVZ7SVG5LHWOAANSMCTJBB3U",
      counter_asset_type: "credit_alphanum4",
      counter_asset_code: "USDC",
      counter_asset_issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      resolution: String(DEX_TRADE_RESOLUTION_15M),
      start_time: "1795530600000",
      end_time: "1795620600000",
      limit: "200",
      order: "asc",
    });
  });

  it("uses testnet Horizon for a testnet pair, a native asset type, and alphanum12 codes", () => {
    const url = new URL(
      buildTradeAggregationsUrl({
        network: "testnet",
        base: "stellar:LONGCODE1:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        counter: "stellar:native",
      }),
    );
    expect(url.host).toBe("horizon-testnet.stellar.org");
    expect(url.searchParams.get("base_asset_type")).toBe("credit_alphanum12");
    expect(url.searchParams.get("counter_asset_type")).toBe("native");
    expect(url.searchParams.has("counter_asset_code")).toBe(false);
  });

  it("refuses assets that are not on-chain Stellar assets, and a bad limit", () => {
    for (const bad of ["iso4217:NGN", "USDC", "stellar:USDC", "stellar:USDC:GNOTANACCOUNT"]) {
      expect(() => buildTradeAggregationsUrl({ ...USDC_XLM, base: bad }), bad).toThrow(
        RangeError,
      );
    }
    expect(() => buildTradeAggregationsUrl({ ...USDC_XLM, counter: USDC })).toThrow(
      /same asset/,
    );
    expect(() => buildTradeAggregationsUrl(USDC_XLM, { limit: 201 })).toThrow(RangeError);
  });
});

describe("tradeAggregationsToSamples (#591)", () => {
  it("turns each recorded bucket into a dex_trade sample with the close price verbatim", () => {
    const records = fixture("usdc-xlm")._embedded!.records!;
    const samples = tradeAggregationsToSamples(records, USDC_XLM);
    expect(samples).toHaveLength(4);
    expect(samples[0]).toEqual({
      network: "public",
      sellAsset: USDC,
      buyAsset: "stellar:native",
      source: "dex_trade",
      anchorDomain: null,
      rate: "8.3257084",
      sampledAt: 1795617000000,
      detail: {
        tradeCount: 1108,
        resolutionMs: 900000,
        baseVolume: "68945.7351596",
        counterVolume: "573046.2486610",
      },
    });
    expect(samples.map((s) => s.rate)).toEqual(records.map((r) => r.close));
  });

  it("skips buckets with zero trades and malformed buckets", () => {
    const [real] = fixture("zarz-usdc")._embedded!.records!;
    const samples = tradeAggregationsToSamples(
      [
        real!,
        { ...real!, timestamp: "1795531500000", trade_count: "0" },
        { ...real!, timestamp: "1795532400000", trade_count: "abc" },
        { ...real!, timestamp: "1795533300000", close: "0.0000000" },
        { ...real!, timestamp: "1795534200000", close: "5.6e-2" },
        { ...real!, timestamp: "not-a-time" },
      ],
      ZARZ_USDC,
    );
    expect(samples.map((s) => s.sampledAt)).toEqual([1795530600000]);
  });
});

describe("collectDexTrades (#591)", () => {
  it("writes every sample through the rate history store", async () => {
    const { fetchImpl, urls } = horizonStub({
      USDC: fixture("usdc-xlm"),
      ZARZ: fixture("zarz-usdc"),
    });
    const { store, inserts } = recordingStore();
    const results = await collectDexTrades([USDC_XLM, ZARZ_USDC], store, { fetch: fetchImpl });

    expect(urls).toHaveLength(2);
    expect(results.map((r) => [r.samples.length, r.inserted])).toEqual([
      [4, 4],
      [5, 5],
    ]);
    // Params follow the store's insert: network, sell, buy, source, anchor domain, rate, ...
    expect(inserts[4]!.slice(0, 7)).toEqual([
      "public",
      ZARZ,
      USDC,
      "dex_trade",
      null,
      "0.0567893",
      new Date(1795530600000).toISOString(),
    ]);
    expect(JSON.parse(inserts[4]![9] as string)).toMatchObject({ tradeCount: 5 });
  });

  it("counts only new samples when the store already has the bucket", async () => {
    const { fetchImpl } = horizonStub({ ZARZ: fixture("zarz-usdc") });
    const db: Queryable = {
      async query<R>() {
        return { rows: [] as R[] }; // on conflict do nothing: nothing returned
      },
    };
    const res = await collectDexTradesForPair(ZARZ_USDC, new PostgresRateHistoryStore(db), {
      fetch: fetchImpl,
    });
    expect(res.samples).toHaveLength(5);
    expect(res.inserted).toBe(0);
  });

  it("fails loudly on a Horizon error instead of storing nothing quietly", async () => {
    const { fetchImpl } = horizonStub({});
    await expect(
      collectDexTradesForPair(USDC_XLM, undefined, { fetch: fetchImpl }),
    ).rejects.toThrow(/HTTP 404/);
  });
});

describe("config/dex-pairs.json (#591)", () => {
  const pairs = loadDexPairsConfig(resolve(process.cwd(), "config/dex-pairs.json"));

  it("is valid", () => {
    expect(pairs.length).toBeGreaterThan(0);
  });

  it("covers the on-chain asset of every corridor that settles on a real network", () => {
    for (const file of ["mx-example", "ng-cowrie", "zeam", "reference"]) {
      const c = loadCorridor(resolve(process.cwd(), "corridors", `${file}.corridor.yaml`));
      if (!c.ok) throw new Error(c.error.message);
      const s = c.value.settlement;
      const asset = `stellar:${s.bridge_asset}:${s.asset_issuer}`;
      expect(
        pairs.some(
          (p) => p.network === s.network && (p.base === asset || p.counter === asset),
        ),
        `${file}: ${asset} on ${s.network}`,
      ).toBe(true);
    }
  });

  it("rejects a malformed config", () => {
    expect(() => parseDexPairsConfig({})).toThrow(/array/);
    expect(() => parseDexPairsConfig([{ ...USDC_XLM, network: "mainnet" }])).toThrow(
      /DEX pair 0: network/,
    );
  });
});
