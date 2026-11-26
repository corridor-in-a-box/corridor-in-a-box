// Rate history collector for Stellar DEX trade prices. RFC 0004 §3, issue #591.
//
// The DEX gives a public price for the same pairs the anchors quote, so it is an
// independent cross-check on anchor prices. This step reads Horizon
// `/trade_aggregations` at a 15-minute resolution for each configured pair and
// writes one `dex_trade` sample per bucket into the rate history store
// (`rate-samples-pg.ts`):
//
// - sell asset = the pair's base, buy asset = its counter, so the stored rate is
//   "counter units per one base unit", which is what Horizon's `close` means;
// - the rate is Horizon's `close` string, stored verbatim (never parsed into a
//   JS number), and the bucket's trade count and volumes go in `detail`;
// - buckets with zero trades are skipped;
// - a DEX price belongs to no anchor, so `anchorDomain` is always null.
//
// Re-reading an overlapping window is safe: the store ignores a second sample for
// the same series and instant.

import { readFileSync } from "node:fs";
import {
  RATE_NETWORKS,
  type RateNetwork,
  type RateSampleInput,
  type PostgresRateHistoryStore,
} from "./rate-samples-pg";

/** Horizon's 15-minute resolution, in milliseconds. */
export const DEX_TRADE_RESOLUTION_15M = 900_000;

/** Horizon's page size ceiling for `/trade_aggregations`. */
export const HORIZON_MAX_LIMIT = 200;

/** One pair to watch. Assets are SEP-38 strings: `stellar:native` or `stellar:CODE:ISSUER`. */
export interface DexPairConfig {
  network: RateNetwork;
  base: string;
  counter: string;
}

/** One bucket as Horizon returns it. Numbers arrive as strings. */
export interface HorizonTradeAggregationRecord {
  timestamp: string | number;
  trade_count: string | number;
  close: string;
  base_volume?: string;
  counter_volume?: string;
  open?: string;
  high?: string;
  low?: string;
  avg?: string;
}

export interface HorizonTradeAggregationsResponse {
  _embedded?: { records?: HorizonTradeAggregationRecord[] };
}

export interface CollectDexTradesOptions {
  /** Overrides the network's public Horizon (e.g. a self-hosted one). */
  horizonUrl?: string;
  /** Bucket size in ms; defaults to 15 minutes. */
  resolution?: number;
  /** Window start, inclusive: epoch ms, Date or ISO timestamp. */
  startTime?: number | Date | string;
  /** Window end, exclusive: epoch ms, Date or ISO timestamp. */
  endTime?: number | Date | string;
  /** Buckets per request, 1..200; defaults to 200 (50 hours of 15-minute buckets). */
  limit?: number;
  fetch?: typeof fetch;
}

/** Where samples go: the rate history store, or anything with the same `record`. */
export type RateSampleSink = Pick<PostgresRateHistoryStore, "record">;

const HORIZON_BY_NETWORK: Record<RateNetwork, string> = {
  testnet: "https://horizon-testnet.stellar.org",
  public: "https://horizon.stellar.org",
};

const STELLAR_ACCOUNT_RE = /^G[A-Z2-7]{55}$/;
const ASSET_CODE_RE = /^[A-Za-z0-9]{1,12}$/;
const DECIMAL_RE = /^\d+(?:\.\d+)?$/;

/** The public Horizon for a network. */
export function defaultHorizonUrl(network: RateNetwork): string {
  return HORIZON_BY_NETWORK[network];
}

/**
 * Horizon query parameters for one side of a pair. Throws on anything that is not
 * `stellar:native` or `stellar:CODE:ISSUER`: a DEX pair is two on-chain assets.
 */
export function horizonAssetParams(
  asset: string,
  prefix: "base" | "counter",
): Record<string, string> {
  if (asset === "stellar:native") return { [`${prefix}_asset_type`]: "native" };
  const parts = asset.split(":");
  const [scheme, code, issuer] = parts;
  if (
    parts.length !== 3 ||
    scheme !== "stellar" ||
    !code ||
    !ASSET_CODE_RE.test(code) ||
    !issuer ||
    !STELLAR_ACCOUNT_RE.test(issuer)
  ) {
    throw new RangeError(
      `${prefix} asset must be "stellar:native" or "stellar:CODE:ISSUER", got ${JSON.stringify(asset)}`,
    );
  }
  return {
    [`${prefix}_asset_type`]: code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
    [`${prefix}_asset_code`]: code,
    [`${prefix}_asset_issuer`]: issuer,
  };
}

function epochMs(value: number | Date | string, field: string): number {
  const ms =
    typeof value === "number"
      ? value
      : value instanceof Date
        ? value.getTime()
        : new Date(value).getTime();
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new RangeError(`${field} must be a valid time`);
  }
  return ms;
}

/** Rejects a pair that Horizon or the store would refuse. */
export function assertDexPair(pair: DexPairConfig): void {
  if (!(RATE_NETWORKS as readonly string[]).includes(pair.network)) {
    throw new RangeError(`network must be one of ${RATE_NETWORKS.join(", ")}`);
  }
  horizonAssetParams(pair.base, "base");
  horizonAssetParams(pair.counter, "counter");
  if (pair.base === pair.counter) {
    throw new RangeError(`base and counter are the same asset (${pair.base})`);
  }
}

/** Drop trailing slashes without a regex (a `/\/+$/` on caller input can backtrack). */
function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end -= 1;
  return url.slice(0, end);
}

/** The `/trade_aggregations` URL for one pair. */
export function buildTradeAggregationsUrl(
  pair: DexPairConfig,
  options: CollectDexTradesOptions = {},
): string {
  assertDexPair(pair);
  const base = trimTrailingSlashes(options.horizonUrl ?? defaultHorizonUrl(pair.network));
  const url = new URL(`${base}/trade_aggregations`);
  for (const [k, v] of Object.entries({
    ...horizonAssetParams(pair.base, "base"),
    ...horizonAssetParams(pair.counter, "counter"),
  })) {
    url.searchParams.set(k, v);
  }
  url.searchParams.set("resolution", String(options.resolution ?? DEX_TRADE_RESOLUTION_15M));
  if (options.startTime !== undefined) {
    url.searchParams.set("start_time", String(epochMs(options.startTime, "startTime")));
  }
  if (options.endTime !== undefined) {
    url.searchParams.set("end_time", String(epochMs(options.endTime, "endTime")));
  }
  const limit = options.limit ?? HORIZON_MAX_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > HORIZON_MAX_LIMIT) {
    throw new RangeError(`limit must be an integer from 1 to ${HORIZON_MAX_LIMIT}`);
  }
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("order", "asc");
  return url.toString();
}

/**
 * Turns Horizon buckets into `dex_trade` samples for the store. Buckets with zero
 * trades, and any with a malformed count, timestamp or close, are skipped.
 */
export function tradeAggregationsToSamples(
  records: readonly HorizonTradeAggregationRecord[],
  pair: DexPairConfig,
  resolution: number = DEX_TRADE_RESOLUTION_15M,
): RateSampleInput[] {
  const samples: RateSampleInput[] = [];
  for (const record of records) {
    const tradeCount = Number(record.trade_count);
    if (!Number.isSafeInteger(tradeCount) || tradeCount <= 0) continue;
    const sampledAt = Number(record.timestamp);
    if (!Number.isSafeInteger(sampledAt) || sampledAt < 0) continue;
    const rate = typeof record.close === "string" ? record.close.trim() : "";
    // The store needs a positive rate; a zero close carries no price.
    if (!DECIMAL_RE.test(rate) || !/[1-9]/.test(rate)) continue;
    samples.push({
      network: pair.network,
      sellAsset: pair.base,
      buyAsset: pair.counter,
      source: "dex_trade",
      anchorDomain: null,
      rate,
      sampledAt,
      detail: {
        tradeCount,
        resolutionMs: resolution,
        ...(record.base_volume !== undefined && { baseVolume: record.base_volume }),
        ...(record.counter_volume !== undefined && { counterVolume: record.counter_volume }),
      },
    });
  }
  return samples;
}

/** Reads one page of buckets for a pair from Horizon. */
export async function fetchTradeAggregations(
  pair: DexPairConfig,
  options: CollectDexTradesOptions = {},
): Promise<HorizonTradeAggregationRecord[]> {
  const url = buildTradeAggregationsUrl(pair, options);
  const res = await (options.fetch ?? fetch)(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Horizon trade_aggregations failed: HTTP ${res.status} for ${url}`);
  }
  const body = (await res.json()) as HorizonTradeAggregationsResponse;
  const records = body?._embedded?.records;
  if (!Array.isArray(records)) {
    throw new Error(`Horizon trade_aggregations returned no records array for ${url}`);
  }
  return records;
}

export interface DexPairResult {
  pair: DexPairConfig;
  samples: RateSampleInput[];
  /** How many samples were new to the store (0 without a sink). */
  inserted: number;
}

/** Collects one pair and, given a sink, stores its samples. */
export async function collectDexTradesForPair(
  pair: DexPairConfig,
  sink?: RateSampleSink,
  options: CollectDexTradesOptions = {},
): Promise<DexPairResult> {
  const records = await fetchTradeAggregations(pair, options);
  const samples = tradeAggregationsToSamples(
    records,
    pair,
    options.resolution ?? DEX_TRADE_RESOLUTION_15M,
  );
  let inserted = 0;
  if (sink) {
    for (const sample of samples) {
      if (await sink.record(sample)) inserted++;
    }
  }
  return { pair, samples, inserted };
}

/** Collects every pair in turn. One pair failing stops the run, so nothing is silently skipped. */
export async function collectDexTrades(
  pairs: readonly DexPairConfig[],
  sink?: RateSampleSink,
  options: CollectDexTradesOptions = {},
): Promise<DexPairResult[]> {
  const results: DexPairResult[] = [];
  for (const pair of pairs) {
    results.push(await collectDexTradesForPair(pair, sink, options));
  }
  return results;
}

/** Parses and checks a pairs config: a JSON array of `{ network, base, counter }`. */
export function parseDexPairsConfig(raw: unknown): DexPairConfig[] {
  if (!Array.isArray(raw)) throw new RangeError("DEX pairs config must be a JSON array");
  return raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new RangeError(`DEX pair ${i} must be an object`);
    }
    const { network, base, counter } = entry as Record<string, unknown>;
    const pair = { network, base, counter } as DexPairConfig;
    try {
      assertDexPair(pair);
    } catch (e) {
      throw new RangeError(`DEX pair ${i}: ${(e as Error).message}`, { cause: e });
    }
    return pair;
  });
}

/** Reads `config/dex-pairs.json` (or another path) and checks every pair. */
export function loadDexPairsConfig(path: string): DexPairConfig[] {
  return parseDexPairsConfig(JSON.parse(readFileSync(path, "utf8")));
}
