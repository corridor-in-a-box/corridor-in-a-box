// Collector step that reads Horizon trade aggregations for configured pairs
// and stores them as rate samples (RFC 0004 / #591).
//
// Invariants:
// - Uses Horizon /trade_aggregations with 15-minute resolution (900000 ms).
// - Preserves close price as exact decimal string (never float).
// - Skips buckets with zero trades.
// - Tags every sample with source="dex_trade".

import { isValidAmount } from "@corridor/types";
import type { RateSampleRecord } from "./rate-samples-pg";
import { readFileSync } from "node:fs";

/** Standard 15-minute resolution for Horizon trade aggregations in milliseconds. */
export const DEX_TRADE_RESOLUTION_15M = 900_000;

export interface DexAssetConfig {
  code: string;
  issuer?: string;
  type?: "native" | "credit_alphanum4" | "credit_alphanum12";
}

export interface DexPairConfig {
  base: DexAssetConfig;
  counter: DexAssetConfig;
  network?: string;
}

export interface HorizonTradeAggregationRecord {
  timestamp: string | number;
  count: string | number;
  opening?: string;
  high?: string;
  low?: string;
  close: string;
  close_r?: { n: number; d: number };
  base_volume?: string;
  counter_volume?: string;
  avg?: string;
}

export interface HorizonTradeAggregationsResponse {
  _embedded?: {
    records?: HorizonTradeAggregationRecord[];
  };
  records?: HorizonTradeAggregationRecord[];
}

export interface CollectDexTradesOptions {
  horizonUrl?: string;
  resolution?: number;
  startTime?: number | Date | string;
  endTime?: number | Date | string;
  limit?: number;
  order?: "asc" | "desc";
  fetch?: typeof fetch;
}

export interface RateSampleSink {
  record(sample: RateSampleRecord): Promise<void>;
}

/** Formats an asset into a canonical asset string. */
export function formatDexAsset(asset: DexAssetConfig): string {
  const isNative =
    asset.type === "native" ||
    asset.code === "native" ||
    (!asset.issuer && asset.code.toUpperCase() === "XLM");
  if (isNative) {
    return "native";
  }
  return asset.issuer ? `${asset.code}:${asset.issuer}` : asset.code;
}

/** Resolves Horizon asset query parameters from asset config. */
export function resolveAssetQueryParams(
  asset: DexAssetConfig,
  prefix: "base" | "counter",
): Record<string, string> {
  const isNative =
    asset.type === "native" ||
    asset.code === "native" ||
    (!asset.issuer && asset.code.toUpperCase() === "XLM");

  if (isNative) {
    return {
      [`${prefix}_asset_type`]: "native",
    };
  }

  const assetType =
    asset.type ?? (asset.code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12");

  const params: Record<string, string> = {
    [`${prefix}_asset_type`]: assetType,
    [`${prefix}_asset_code`]: asset.code,
  };

  if (asset.issuer) {
    params[`${prefix}_asset_issuer`] = asset.issuer;
  }

  return params;
}

/** Resolves the default Horizon URL for a network name. */
export function defaultHorizonUrl(network: string = "public"): string {
  const n = network.toLowerCase();
  if (n === "testnet") {
    return "https://horizon-testnet.stellar.org";
  }
  return "https://horizon.stellar.org";
}

/**
 * Builds the Horizon /trade_aggregations URL for a configured pair and options.
 */
export function buildTradeAggregationsUrl(
  pair: DexPairConfig,
  options: CollectDexTradesOptions = {},
): string {
  const network = pair.network ?? "public";
  const baseUrl = (options.horizonUrl ?? defaultHorizonUrl(network)).replace(/\/+$/, "");
  const url = new URL(`${baseUrl}/trade_aggregations`);

  const baseParams = resolveAssetQueryParams(pair.base, "base");
  for (const [k, v] of Object.entries(baseParams)) {
    url.searchParams.set(k, v);
  }

  const counterParams = resolveAssetQueryParams(pair.counter, "counter");
  for (const [k, v] of Object.entries(counterParams)) {
    url.searchParams.set(k, v);
  }

  const resolution = options.resolution ?? DEX_TRADE_RESOLUTION_15M;
  url.searchParams.set("resolution", resolution.toString());

  if (options.startTime !== undefined) {
    const startMs =
      options.startTime instanceof Date
        ? options.startTime.getTime()
        : typeof options.startTime === "string"
          ? new Date(options.startTime).getTime()
          : options.startTime;
    url.searchParams.set("start_time", startMs.toString());
  }

  if (options.endTime !== undefined) {
    const endMs =
      options.endTime instanceof Date
        ? options.endTime.getTime()
        : typeof options.endTime === "string"
          ? new Date(options.endTime).getTime()
          : options.endTime;
    url.searchParams.set("end_time", endMs.toString());
  }

  if (options.limit !== undefined) {
    url.searchParams.set("limit", options.limit.toString());
  }

  if (options.order) {
    url.searchParams.set("order", options.order);
  }

  return url.toString();
}

/**
 * Transforms raw Horizon trade aggregation records into RateSampleRecords.
 *
 * Rules:
 * - Drops buckets where trade count is 0.
 * - Extracts close price verbatim without float conversion.
 * - Tags source as "dex_trade".
 * - Stores tradeCount and volume in detail.
 */
export function transformTradeAggregations(
  records: readonly HorizonTradeAggregationRecord[],
  pair: DexPairConfig,
  networkOverride?: string,
): RateSampleRecord[] {
  const network = networkOverride ?? pair.network ?? "public";
  const sellAsset = formatDexAsset(pair.base);
  const buyAsset = formatDexAsset(pair.counter);
  const pairKey = `${sellAsset}:${buyAsset}`;

  const samples: RateSampleRecord[] = [];

  for (const record of records) {
    const tradeCount =
      typeof record.count === "number" ? record.count : parseInt(record.count, 10);

    // Skip buckets with zero trades
    if (Number.isNaN(tradeCount) || tradeCount <= 0) {
      continue;
    }

    const rate = record.close;
    if (!rate || !isValidAmount(rate)) {
      continue;
    }

    const timestampMs =
      typeof record.timestamp === "number" ? record.timestamp : parseInt(record.timestamp, 10);

    samples.push({
      pair: pairKey,
      sellAsset,
      buyAsset,
      source: "dex_trade",
      rate,
      sampledAt: timestampMs,
      network,
      detail: {
        tradeCount,
        baseVolume: record.base_volume ?? null,
        counterVolume: record.counter_volume ?? null,
        open: record.opening ?? null,
        high: record.high ?? null,
        low: record.low ?? null,
        avg: record.avg ?? null,
      },
    });
  }

  return samples;
}

/**
 * Fetches trade aggregations from Horizon for a given pair.
 */
export async function fetchTradeAggregations(
  pair: DexPairConfig,
  options: CollectDexTradesOptions = {},
): Promise<HorizonTradeAggregationRecord[]> {
  const fetchImpl = options.fetch ?? fetch;
  const url = buildTradeAggregationsUrl(pair, options);

  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(
      `failed to fetch Horizon trade aggregations from ${url}: HTTP ${res.status} ${res.statusText}`,
    );
  }

  const json = (await res.json()) as HorizonTradeAggregationsResponse;
  const records = json._embedded?.records ?? json.records ?? [];
  return records;
}

/**
 * Collects DEX trade samples for a single pair and optionally stores them in a RateSampleSink.
 */
export async function collectDexTradesForPair(
  pair: DexPairConfig,
  store?: RateSampleSink,
  options: CollectDexTradesOptions = {},
): Promise<RateSampleRecord[]> {
  const records = await fetchTradeAggregations(pair, options);
  const samples = transformTradeAggregations(
    records,
    pair,
    options.horizonUrl ? undefined : pair.network,
  );

  if (store) {
    for (const sample of samples) {
      await store.record(sample);
    }
  }

  return samples;
}

/**
 * Collects DEX trade samples for multiple configured pairs.
 */
export async function collectDexTrades(
  pairs: readonly DexPairConfig[],
  store?: RateSampleSink,
  options: CollectDexTradesOptions = {},
): Promise<RateSampleRecord[]> {
  const allSamples: RateSampleRecord[] = [];
  for (const pair of pairs) {
    const samples = await collectDexTradesForPair(pair, store, options);
    allSamples.push(...samples);
  }
  return allSamples;
}

/**
 * Loads DEX pair configurations from a JSON file path or returns array directly.
 */
export function loadDexPairsConfig(
  configPathOrPairs: string | readonly DexPairConfig[],
): DexPairConfig[] {
  if (typeof configPathOrPairs !== "string") {
    return [...configPathOrPairs];
  }
  const content = readFileSync(configPathOrPairs, "utf-8");
  return JSON.parse(content) as DexPairConfig[];
}
