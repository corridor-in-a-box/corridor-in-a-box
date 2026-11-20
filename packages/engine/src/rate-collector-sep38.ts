// Rate history: poll SEP-38 indicative prices from attested anchors (#590, RFC 0004 §3).
//
// Collector step that reads anchors from the conformance registry (anchors whose
// `sep38_quote` probe passed), discovers trading pairs via GET /prices, queries
// indicative prices via GET /price for a reference amount, and records rate samples.
//
// Invariants:
// - Samples are tagged with source="sep38_price" and the anchor domain.
// - Strict per-anchor timeout and error isolation: failures on one anchor do not stop others.
// - Prices are stored as exact decimal strings (never floats).
// - Produces one sample per pair per anchor run.

import { isValidAmount } from "@corridor/types";
import { silentLogger, type Logger } from "./observability";

/** Collector step result format. */
export interface CollectorStepResult {
  collected?: number;
  [key: string]: unknown;
}

/** Standard collector step interface compatible with the rate collector scheduler. */
export interface CollectorStep {
  name: string;
  run: () => Promise<CollectorStepResult | void>;
}

/** Default reference amount used for GET /price queries (RFC 0004 §3). */
export const DEFAULT_SEP38_REFERENCE_AMOUNT = "100";

/** Default timeout per anchor query in milliseconds. */
export const DEFAULT_SEP38_TIMEOUT_MS = 5_000;

/** Default reference sell asset for pair discovery. */
export const DEFAULT_SEP38_SELL_ASSET = "stellar:USDC";

export interface Sep38AnchorTarget {
  readonly domain: string;
  readonly quoteServerUrl?: string;
  readonly sellAssets?: readonly string[];
  readonly network?: string;
}

export interface Sep38RateSample {
  readonly id?: string | number;
  readonly pair: string;
  readonly sellAsset: string;
  readonly buyAsset: string;
  readonly rate: string;
  readonly source: "sep38_price";
  readonly anchorDomain: string;
  readonly sampledAt: number;
  readonly network: string;
  readonly detail?: {
    readonly totalPrice?: string;
    readonly sellAmount?: string;
    readonly buyAmount?: string;
    readonly fee?: unknown;
    readonly expiresAt?: string;
    readonly [key: string]: unknown;
  };
}

export interface RateSampleSink {
  record(sample: Sep38RateSample): void | Promise<void>;
}

export type RateSampleSinkInput = RateSampleSink | ((sample: Sep38RateSample) => unknown);

export interface RegistryLike {
  domains(): Promise<string[]>;
  getAnchor(domain: string): Promise<{ probesPassed: readonly string[] }>;
}

export interface CollectSep38RatesOptions {
  /**
   * Explicit list of anchor targets or domain names to poll.
   * When omitted, targets are discovered from `registry` or `attestations`.
   */
  readonly anchors?: readonly (string | Sep38AnchorTarget)[];

  /**
   * Registry instance to query for anchors whose `sep38_quote` probe passed.
   */
  readonly registry?: RegistryLike;

  /**
   * Pre-fetched attestation records to filter for `sep38_quote`.
   */
  readonly attestations?: readonly { domain: string; probesPassed: readonly string[] }[];

  /**
   * Sink or callback function to store collected rate samples.
   */
  readonly store?: RateSampleSinkInput;

  /**
   * Fixed reference amount used for GET /price queries.
   * Defaults to DEFAULT_SEP38_REFERENCE_AMOUNT ("100").
   */
  readonly referenceAmount?: string;

  /**
   * Default sell asset used when querying /prices.
   * Defaults to DEFAULT_SEP38_SELL_ASSET ("stellar:USDC").
   */
  readonly defaultSellAsset?: string;

  /**
   * Target network tag for samples ("public" or "testnet").
   * Defaults to "public".
   */
  readonly network?: string;

  /**
   * Per-anchor request timeout in milliseconds.
   * Defaults to DEFAULT_SEP38_TIMEOUT_MS (5000 ms).
   */
  readonly timeoutMs?: number;

  /**
   * Custom fetch implementation (for testing and mocking).
   */
  readonly fetch?: typeof fetch;

  /**
   * Time provider returning current epoch milliseconds.
   * Defaults to Date.now.
   */
  readonly now?: () => number;

  /**
   * Logger instance for operational logs and isolated error diagnostics.
   */
  readonly logger?: Logger;

  /**
   * Optional resolver function to locate an anchor's SEP-38 quote server URL.
   */
  readonly resolveQuoteServer?: (
    domain: string,
  ) => Promise<string | undefined> | string | undefined;
}

export interface CollectSep38RatesResult {
  readonly samples: readonly Sep38RateSample[];
  readonly anchorsAttempted: number;
  readonly anchorsSucceeded: number;
  readonly anchorsFailed: number;
  readonly errorsByDomain: Readonly<Record<string, string>>;
}

export interface DiscoveredPair {
  readonly sellAsset: string;
  readonly buyAsset: string;
}

/**
 * Filters attestation records to domains whose `sep38_quote` probe passed.
 */
export function findSep38AttestedAnchors(
  attestations: readonly { domain: string; probesPassed: readonly string[] }[],
): string[] {
  return attestations
    .filter((a) => a.probesPassed.includes("sep38_quote"))
    .map((a) => a.domain);
}

/**
 * Queries a registry instance to find all anchor domains whose `sep38_quote` probe passed.
 */
export async function getSep38AttestedDomains(registry: RegistryLike): Promise<string[]> {
  const domains = await registry.domains();
  const passing: string[] = [];
  for (const domain of domains) {
    try {
      const record = await registry.getAnchor(domain);
      if (record.probesPassed.includes("sep38_quote")) {
        passing.push(domain);
      }
    } catch {
      // Ignore individual lookup errors when scanning registry
    }
  }
  return passing;
}

/**
 * Parses a SEP-38 /prices response into a list of unique trading pairs.
 */
export function parsePricesResponse(
  data: unknown,
  fallbackSellAsset: string = DEFAULT_SEP38_SELL_ASSET,
): DiscoveredPair[] {
  if (!data || typeof data !== "object") {
    return [];
  }

  const pairs: DiscoveredPair[] = [];
  const seen = new Set<string>();

  const addPair = (sellAsset: string, buyAsset: string) => {
    if (!sellAsset || !buyAsset || sellAsset === buyAsset) return;
    const key = `${sellAsset}:${buyAsset}`;
    if (!seen.has(key)) {
      seen.add(key);
      pairs.push({ sellAsset, buyAsset });
    }
  };

  const obj = data as Record<string, unknown>;

  // Format 1: { prices: [{ sell_asset: "...", buy_asset: "..." }] }
  if (Array.isArray(obj.prices)) {
    for (const item of obj.prices) {
      if (item && typeof item === "object") {
        const p = item as Record<string, unknown>;
        const sell = String(p.sell_asset ?? p.sellAsset ?? "");
        const buy = String(p.buy_asset ?? p.buyAsset ?? "");
        if (sell && buy) {
          addPair(sell, buy);
        }
      }
    }
  }

  // Format 2: { buy_assets: [{ asset: "..." }] } relative to sell_asset
  if (Array.isArray(obj.buy_assets)) {
    for (const item of obj.buy_assets) {
      if (item && typeof item === "object") {
        const b = item as Record<string, unknown>;
        const buy = String(b.asset ?? "");
        if (buy) {
          addPair(fallbackSellAsset, buy);
        }
      }
    }
  }

  // Format 3: { sell_assets: [{ asset: "..." }] } relative to buy_asset
  if (Array.isArray(obj.sell_assets)) {
    for (const item of obj.sell_assets) {
      if (item && typeof item === "object") {
        const s = item as Record<string, unknown>;
        const sell = String(s.asset ?? "");
        if (sell) {
          addPair(sell, fallbackSellAsset);
        }
      }
    }
  }

  return pairs;
}

async function recordSample(
  store: RateSampleSinkInput | undefined,
  sample: Sep38RateSample,
): Promise<void> {
  if (!store) return;
  if (typeof store === "function") {
    await store(sample);
  } else if ("record" in store) {
    await store.record(sample);
  }
}

/**
 * Polls indicative prices from a single anchor target.
 * Throws on failure so callers can catch and isolate errors per anchor.
 */
export async function collectSep38RatesForAnchor(
  target: Sep38AnchorTarget,
  options: CollectSep38RatesOptions = {},
): Promise<Sep38RateSample[]> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SEP38_TIMEOUT_MS;
  const refAmount = options.referenceAmount ?? DEFAULT_SEP38_REFERENCE_AMOUNT;
  const now = options.now ?? Date.now;
  const network = target.network ?? options.network ?? "public";

  const resolvedUrl =
    target.quoteServerUrl ??
    (options.resolveQuoteServer
      ? await options.resolveQuoteServer(target.domain)
      : undefined) ??
    `https://${target.domain}/sep38`;
  const baseUrl = resolvedUrl.replace(/\/+$/, "");

  const sellAssets = target.sellAssets?.length
    ? target.sellAssets
    : [options.defaultSellAsset ?? DEFAULT_SEP38_SELL_ASSET];

  const allDiscoveredPairs: DiscoveredPair[] = [];
  const seenPairs = new Set<string>();

  for (const sellAsset of sellAssets) {
    const pricesUrl = new URL(`${baseUrl}/prices`);
    pricesUrl.searchParams.set("sell_asset", sellAsset);

    const pricesRes = await fetchImpl(pricesUrl.toString(), {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });

    if (pricesRes.status === 401) {
      throw new Error(
        `SEP-38 authentication required: HTTP 401 Unauthorized from ${pricesUrl.toString()}`,
      );
    }
    if (!pricesRes.ok) {
      throw new Error(`GET /prices returned HTTP ${pricesRes.status} ${pricesRes.statusText}`);
    }

    let pricesData: unknown;
    try {
      pricesData = await pricesRes.json();
    } catch (parseErr) {
      throw new Error(
        `malformed JSON response from ${pricesUrl.toString()}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        { cause: parseErr },
      );
    }

    const pairs = parsePricesResponse(pricesData, sellAsset);
    for (const pair of pairs) {
      const key = `${pair.sellAsset}:${pair.buyAsset}`;
      if (!seenPairs.has(key)) {
        seenPairs.add(key);
        allDiscoveredPairs.push(pair);
      }
    }
  }

  const samples: Sep38RateSample[] = [];

  for (const pair of allDiscoveredPairs) {
    const priceUrl = new URL(`${baseUrl}/price`);
    priceUrl.searchParams.set("sell_asset", pair.sellAsset);
    priceUrl.searchParams.set("buy_asset", pair.buyAsset);
    priceUrl.searchParams.set("sell_amount", refAmount);

    const priceRes = await fetchImpl(priceUrl.toString(), {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });

    if (priceRes.status === 401) {
      throw new Error(
        `SEP-38 authentication required: HTTP 401 Unauthorized from ${priceUrl.toString()}`,
      );
    }
    if (!priceRes.ok) {
      throw new Error(`GET /price returned HTTP ${priceRes.status} ${priceRes.statusText}`);
    }

    let priceData: unknown;
    try {
      priceData = await priceRes.json();
    } catch (parseErr) {
      throw new Error(
        `malformed JSON response from ${priceUrl.toString()}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        { cause: parseErr },
      );
    }

    if (!priceData || typeof priceData !== "object") {
      throw new Error(`malformed response body from ${priceUrl.toString()}`);
    }

    const obj = priceData as Record<string, unknown>;
    const rateVal =
      typeof obj.price === "string"
        ? obj.price
        : typeof obj.total_price === "string"
          ? obj.total_price
          : undefined;

    if (!rateVal || !isValidAmount(rateVal)) {
      throw new Error(
        `invalid or missing price value ("${rateVal}") from ${priceUrl.toString()}`,
      );
    }

    const sample: Sep38RateSample = {
      pair: `${pair.sellAsset}:${pair.buyAsset}`,
      sellAsset: pair.sellAsset,
      buyAsset: pair.buyAsset,
      rate: rateVal,
      source: "sep38_price",
      anchorDomain: target.domain,
      sampledAt: now(),
      network,
      detail: {
        totalPrice: typeof obj.total_price === "string" ? obj.total_price : undefined,
        sellAmount: typeof obj.sell_amount === "string" ? obj.sell_amount : undefined,
        buyAmount: typeof obj.buy_amount === "string" ? obj.buy_amount : undefined,
        fee: obj.fee,
        expiresAt: typeof obj.expires_at === "string" ? obj.expires_at : undefined,
      },
    };

    samples.push(sample);
    await recordSample(options.store, sample);
  }

  return samples;
}

/**
 * Resolves the targets to poll from anchors, registry, or attestations.
 */
async function resolveAnchorTargets(
  options: CollectSep38RatesOptions,
): Promise<Sep38AnchorTarget[]> {
  if (options.anchors && options.anchors.length > 0) {
    return options.anchors.map((a) => (typeof a === "string" ? { domain: a } : a));
  }

  if (options.attestations) {
    const domains = findSep38AttestedAnchors(options.attestations);
    return domains.map((domain) => ({ domain }));
  }

  if (options.registry) {
    const domains = await getSep38AttestedDomains(options.registry);
    return domains.map((domain) => ({ domain }));
  }

  return [];
}

/**
 * Collects SEP-38 indicative price samples from attested anchors with error isolation.
 */
export async function collectSep38Rates(
  options: CollectSep38RatesOptions = {},
): Promise<CollectSep38RatesResult> {
  const logger = options.logger ?? silentLogger;
  const targets = await resolveAnchorTargets(options);
  const samples: Sep38RateSample[] = [];
  const errorsByDomain: Record<string, string> = {};
  let anchorsSucceeded = 0;
  let anchorsFailed = 0;

  logger.log("info", "corridor.rate_collector.sep38.run_started", {
    targetCount: targets.length,
    targets: targets.map((t) => t.domain),
  });

  for (const target of targets) {
    try {
      const anchorSamples = await collectSep38RatesForAnchor(target, options);
      samples.push(...anchorSamples);
      anchorsSucceeded++;
      logger.log("info", "corridor.rate_collector.sep38.anchor_succeeded", {
        domain: target.domain,
        sampleCount: anchorSamples.length,
      });
    } catch (err) {
      anchorsFailed++;
      const errorMessage = err instanceof Error ? err.message : String(err);
      errorsByDomain[target.domain] = errorMessage;
      logger.log("warn", "corridor.rate_collector.sep38.anchor_failed", {
        domain: target.domain,
        error: errorMessage,
      });
      // Error isolation: failing anchor does not crash or stop the run
    }
  }

  logger.log("info", "corridor.rate_collector.sep38.run_completed", {
    anchorsAttempted: targets.length,
    anchorsSucceeded,
    anchorsFailed,
    sampleCount: samples.length,
  });

  return {
    samples,
    anchorsAttempted: targets.length,
    anchorsSucceeded,
    anchorsFailed,
    errorsByDomain,
  };
}

/**
 * Creates a CollectorStep suitable for execution in a RateCollectorLoop.
 */
export function createSep38CollectorStep(
  options: CollectSep38RatesOptions = {},
): CollectorStep {
  return {
    name: "sep38_prices",
    run: async () => {
      const res = await collectSep38Rates(options);
      return {
        collected: res.samples.length,
        anchorsAttempted: res.anchorsAttempted,
        anchorsSucceeded: res.anchorsSucceeded,
        anchorsFailed: res.anchorsFailed,
      };
    },
  };
}
