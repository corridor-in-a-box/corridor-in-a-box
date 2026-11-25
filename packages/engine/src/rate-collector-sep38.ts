// Rate history: poll SEP-38 indicative prices from attested anchors (#590, RFC 0004 §3).
//
// One call to `pollSep38Prices` is one collector run. A scheduler (the always-on collector
// loop) calls it every 15 minutes; this module has no timer of its own.
//
// For every anchor it polls:
//
//   1. The quote server is read from `ANCHOR_QUOTE_SERVER` in the anchor's own stellar.toml.
//      It is never guessed from the domain, and it must be a public https:// URL.
//   2. The Stellar assets the anchor prices are read from `GET {quote}/info`, so every sell
//      asset is an issuer-qualified SEP-38 id (`stellar:CODE:ISSUER` or `stellar:native`).
//   3. `GET {quote}/prices?sell_asset=…&sell_amount=…` lists the pairs (its `buy_assets`).
//   4. `GET {quote}/price` is asked once per pair for the same reference amount, through the
//      router's `fetchIndicativePrice`, so the repository has one SEP-38 /price client.
//   5. Each price is written through `PostgresRateHistoryStore.record()` as a `sep38_price`
//      sample tagged with the anchor domain.
//
// SEP-38 `price` is sell units per ONE buy unit. Rate history stores buy units per one sell
// unit, so the stored rate is `buy_amount ÷ sell_amount` (fees included), computed on scaled
// integers by `fetchIndicativePrice` and rounded half-up to 18 places. No price passes through
// a JS number.
//
// Failures are isolated. An anchor whose toml, /info or every /prices call fails is reported
// as failed; one sell asset or one pair failing leaves the rest of that anchor's pairs alone;
// and one anchor failing never stops the others. Nothing here throws for a network problem.
//
// The collector only reads public prices: it holds no keys and moves no funds.

import { isCanonicalDomain, isSafeUrl, PROBE_USER_AGENT, tomlValue } from "@corridor/probe";
import { fetchIndicativePrice } from "@corridor/router";
import { isSettleableAmount } from "@corridor/types";
import { silentLogger, type Logger } from "./observability";
import {
  isSep38AssetId,
  RATE_NETWORKS,
  type RateNetwork,
  type RateSampleInput,
} from "./rate-samples-pg";

/** The amount of the sell asset every price is asked for (RFC 0004 §3 "fixed reference amount"). */
export const DEFAULT_SEP38_REFERENCE_AMOUNT = "100";

/** Timeout for each HTTP request made to an anchor, in milliseconds. */
export const DEFAULT_SEP38_TIMEOUT_MS = 10_000;

/**
 * How old an attestation may be and still count, in ledgers: about one week at 5 s ledgers,
 * the same default the router's attestation gate uses.
 */
export const DEFAULT_SEP38_MAX_STALENESS_LEDGERS = 120_960;

/**
 * Decimal places kept in a stored rate. The rate is a division, so it has to be rounded
 * somewhere; 18 places keep the significant digits of a small rate (USD per NGN, say).
 */
const SEP38_RATE_SCALE = 18;

/** The probe whose pass means the anchor's quote server answered for real. */
const SEP38_PROBE = "sep38_quote";

/**
 * The part of `@corridor/registry`'s `AnchorRegistry` the collector needs. Declared
 * structurally so the engine does not depend on a Soroban client.
 */
export interface Sep38AttestationSource {
  domains(): Promise<string[]>;
  getAnchor(domain: string): Promise<{ readonly probesPassed: readonly string[] }>;
  staleness(domain: string): Promise<number>;
}

/** Where samples are written. `PostgresRateHistoryStore` is the implementation. */
export interface RateSampleRecorder {
  /** Stores one sample; resolves false when that series already has a sample at that instant. */
  record(sample: RateSampleInput): Promise<boolean>;
}

/** An anchor to poll, named directly instead of found in the registry. */
export interface Sep38PollTarget {
  readonly domain: string;
  /** Sell assets to ask `/prices` about. Default: the Stellar assets the anchor's `/info` lists. */
  readonly sellAssets?: readonly string[];
}

export interface PollSep38PricesOptions {
  /** The Stellar network the anchors serve; every sample is tagged with it. */
  readonly network: RateNetwork;
  /** Where samples are written. */
  readonly store: RateSampleRecorder;
  /**
   * The on-chain registry. Every domain whose `sep38_quote` probe passed, with an attestation
   * no older than `maxStalenessLedgers`, is polled.
   */
  readonly registry?: Sep38AttestationSource;
  /** Anchors to poll in addition to the registry's, e.g. a local reference anchor. */
  readonly anchors?: readonly (string | Sep38PollTarget)[];
  /** Default {@link DEFAULT_SEP38_MAX_STALENESS_LEDGERS}. */
  readonly maxStalenessLedgers?: number;
  /**
   * Sell assets to use for every anchor that does not name its own, as issuer-qualified
   * SEP-38 ids. Default: whatever Stellar assets each anchor's `/info` lists.
   */
  readonly sellAssets?: readonly string[];
  /** Sell amount used for `/prices` and `/price`. Default {@link DEFAULT_SEP38_REFERENCE_AMOUNT}. */
  readonly referenceAmount?: string;
  /** Per-request timeout in milliseconds. Default {@link DEFAULT_SEP38_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  /** Clock for `sampledAt`, epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  readonly logger?: Logger;
}

/** What happened to one pair. */
export interface Sep38PairOutcome {
  readonly sellAsset: string;
  readonly buyAsset: string;
  /** Buy units per one sell unit, as stored. Absent when the pair failed. */
  readonly rate?: string;
  /** True when a new sample was stored, false when that instant was already stored. */
  readonly recorded?: boolean;
  readonly error?: string;
}

/** What happened to one anchor. */
export interface Sep38AnchorOutcome {
  readonly domain: string;
  /** The `ANCHOR_QUOTE_SERVER` read from the anchor's stellar.toml, when one was found. */
  readonly quoteServer?: string;
  /**
   * `ok`: every listed pair was stored. `partial`: some were. `failed`: none could be, or the
   * anchor could not be reached at all.
   */
  readonly status: "ok" | "partial" | "failed";
  readonly pairs: readonly Sep38PairOutcome[];
  /** Every problem met, in order: anchor-level ones first, then per sell asset and per pair. */
  readonly errors: readonly string[];
}

/** A registry domain that was not polled, and why. */
export interface Sep38SkippedAnchor {
  readonly domain: string;
  readonly reason: string;
}

export interface Sep38PollResult {
  readonly anchors: readonly Sep38AnchorOutcome[];
  readonly skipped: readonly Sep38SkippedAnchor[];
  /** Set when the registry's domain list could not be read. Explicit anchors are still polled. */
  readonly registryError?: string;
  /** New samples stored. */
  readonly recorded: number;
  /** Samples already stored at that instant (a retried run). */
  readonly duplicates: number;
  /** Anchors with status `failed`. */
  readonly anchorsFailed: number;
}

const message = (e: unknown): string => {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause instanceof Error ? e.cause.message : undefined;
  return cause && !e.message.includes(cause) ? `${e.message} (${cause})` : e.message;
};

const isStellarSep38Asset = (asset: unknown): asset is string =>
  isSep38AssetId(asset) && asset.startsWith("stellar:");

function assertSellAssets(assets: readonly string[], field: string): void {
  for (const asset of assets) {
    if (!isStellarSep38Asset(asset)) {
      throw new RangeError(
        `${field} must be issuer-qualified Stellar SEP-38 assets (stellar:CODE:ISSUER or stellar:native), got ${JSON.stringify(asset)}`,
      );
    }
  }
}

/**
 * The registry domains to poll: `sep38_quote` passed and the attestation is fresh. A domain
 * whose record cannot be read is skipped, never assumed to qualify.
 */
export async function findSep38Anchors(
  registry: Sep38AttestationSource,
  maxStalenessLedgers: number = DEFAULT_SEP38_MAX_STALENESS_LEDGERS,
): Promise<{ domains: string[]; skipped: Sep38SkippedAnchor[] }> {
  const all = await registry.domains();
  const checked = await Promise.all(
    all.map(async (domain): Promise<{ domain: string; reason?: string }> => {
      try {
        const [record, age] = await Promise.all([
          registry.getAnchor(domain),
          registry.staleness(domain),
        ]);
        if (!record.probesPassed.includes(SEP38_PROBE)) {
          return { domain, reason: `${SEP38_PROBE} probe has not passed` };
        }
        if (age > maxStalenessLedgers) {
          return {
            domain,
            reason: `attestation is ${age} ledgers old, over the ${maxStalenessLedgers} ledger limit`,
          };
        }
        return { domain };
      } catch (e) {
        return { domain, reason: `registry lookup failed: ${message(e)}` };
      }
    }),
  );
  return {
    domains: checked.filter((c) => c.reason === undefined).map((c) => c.domain),
    skipped: checked
      .filter((c): c is Sep38SkippedAnchor => c.reason !== undefined)
      .map(({ domain, reason }) => ({ domain, reason })),
  };
}

/** A fetch that times out, identifies the collector, and asks for JSON. */
function timedFetch(fetchImpl: typeof fetch, timeoutMs: number): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    if (!headers.has("user-agent")) headers.set("user-agent", PROBE_USER_AGENT);
    return fetchImpl(input, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
  };
}

async function getJson(get: typeof fetch, url: string, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await get(url);
  } catch (e) {
    throw new Error(`${what} request failed: ${message(e)}`, { cause: e });
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`${what} HTTP ${res.status}: the anchor requires SEP-10 authentication`);
  }
  if (!res.ok) throw new Error(`${what} HTTP ${res.status}`);
  try {
    return await res.json();
  } catch (e) {
    throw new Error(`${what} returned a body that is not JSON: ${message(e)}`, {
      cause: e,
    });
  }
}

/** What the anchor's stellar.toml says about its quote server and the context to price in. */
export interface Sep38TomlEndpoints {
  readonly quoteServer: string;
  /** SEP-38 `context`: `sep6` only for an anchor with a TRANSFER_SERVER and no SEP-31 server. */
  readonly context: "sep31" | "sep6";
}

/**
 * Read `ANCHOR_QUOTE_SERVER` from `https://{domain}/.well-known/stellar.toml`. Throws when the
 * toml cannot be read, names no quote server, or names one that is not a public https:// URL.
 */
export async function resolveSep38QuoteServer(
  domain: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<Sep38TomlEndpoints> {
  if (!isCanonicalDomain(domain)) throw new Error(`not a canonical domain: ${domain}`);
  const get = timedFetch(opts.fetch ?? fetch, opts.timeoutMs ?? DEFAULT_SEP38_TIMEOUT_MS);
  const url = `https://${domain}/.well-known/stellar.toml`;
  let toml: string;
  try {
    const res = await get(url, { headers: { accept: "text/plain, application/toml, */*" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toml = await res.text();
  } catch (e) {
    throw new Error(`stellar.toml could not be read: ${message(e)}`, { cause: e });
  }
  const quoteServer = tomlValue(toml, "ANCHOR_QUOTE_SERVER");
  if (!quoteServer) throw new Error("stellar.toml has no ANCHOR_QUOTE_SERVER");
  if (!isSafeUrl(quoteServer)) {
    throw new Error(
      `refusing ANCHOR_QUOTE_SERVER that is not a public https URL: ${quoteServer}`,
    );
  }
  const sep6Only =
    tomlValue(toml, "TRANSFER_SERVER") !== undefined &&
    tomlValue(toml, "DIRECT_PAYMENT_SERVER") === undefined;
  return {
    quoteServer: quoteServer.replace(/\/+$/, ""),
    context: sep6Only ? "sep6" : "sep31",
  };
}

/** The Stellar assets a SEP-38 `GET /info` body lists, in order. Other entries are ignored. */
export function stellarAssetsFromInfo(body: unknown): string[] {
  const assets = (body as { assets?: unknown } | null)?.assets;
  if (!Array.isArray(assets)) throw new Error("GET /info has no assets list");
  const out: string[] = [];
  for (const entry of assets) {
    const asset = (entry as { asset?: unknown } | null)?.asset;
    if (isStellarSep38Asset(asset) && !out.includes(asset)) out.push(asset);
  }
  return out;
}

/**
 * The buy assets a SEP-38 `GET /prices?sell_asset=…` body lists, in order. An entry that is
 * not a SEP-38 asset id is dropped; a body with no `buy_assets` list is malformed.
 */
export function buyAssetsFromPrices(body: unknown): string[] {
  const buyAssets = (body as { buy_assets?: unknown } | null)?.buy_assets;
  if (!Array.isArray(buyAssets)) throw new Error("GET /prices has no buy_assets list");
  const out: string[] = [];
  for (const entry of buyAssets) {
    const asset = (entry as { asset?: unknown } | null)?.asset;
    if (isSep38AssetId(asset) && !out.includes(asset)) out.push(asset);
  }
  return out;
}

interface AnchorPollContext {
  readonly network: RateNetwork;
  readonly store: RateSampleRecorder;
  readonly sellAssets?: readonly string[];
  readonly referenceAmount: string;
  readonly timeoutMs: number;
  readonly fetchImpl: typeof fetch;
  readonly now: () => number;
}

/** Poll one anchor. Never throws: every problem lands in the outcome's `errors`. */
async function pollAnchor(
  target: Sep38PollTarget,
  ctx: AnchorPollContext,
): Promise<Sep38AnchorOutcome> {
  const domain = target.domain;
  const errors: string[] = [];
  const pairs: Sep38PairOutcome[] = [];
  const failed = (error: string, quoteServer?: string): Sep38AnchorOutcome => ({
    domain,
    ...(quoteServer ? { quoteServer } : {}),
    status: "failed",
    pairs,
    errors: [...errors, error],
  });

  const get = timedFetch(ctx.fetchImpl, ctx.timeoutMs);

  let endpoints: Sep38TomlEndpoints;
  try {
    endpoints = await resolveSep38QuoteServer(domain, {
      fetch: ctx.fetchImpl,
      timeoutMs: ctx.timeoutMs,
    });
  } catch (e) {
    return failed(message(e));
  }
  const { quoteServer, context } = endpoints;

  let sellAssets = target.sellAssets ?? ctx.sellAssets;
  if (!sellAssets) {
    try {
      sellAssets = stellarAssetsFromInfo(
        await getJson(get, `${quoteServer}/info`, "GET /info"),
      );
    } catch (e) {
      return failed(message(e), quoteServer);
    }
    if (sellAssets.length === 0)
      return failed("GET /info lists no Stellar asset", quoteServer);
  }

  const listed: { sellAsset: string; buyAsset: string }[] = [];
  let pricesAnswered = 0;
  for (const sellAsset of sellAssets) {
    const params = new URLSearchParams({
      sell_asset: sellAsset,
      sell_amount: ctx.referenceAmount,
    });
    try {
      const body = await getJson(get, `${quoteServer}/prices?${params}`, "GET /prices");
      for (const buyAsset of buyAssetsFromPrices(body)) {
        if (buyAsset !== sellAsset) listed.push({ sellAsset, buyAsset });
      }
      pricesAnswered++;
    } catch (e) {
      errors.push(`${sellAsset}: ${message(e)}`);
    }
  }
  if (pricesAnswered === 0) {
    return { domain, quoteServer, status: "failed", pairs, errors };
  }

  for (const { sellAsset, buyAsset } of listed) {
    const priced = await fetchIndicativePrice({
      domain,
      quoteServer,
      sellAsset,
      buyAsset,
      sellAmount: ctx.referenceAmount,
      context,
      rateScale: SEP38_RATE_SCALE,
      fetchImpl: get,
    });
    if (!priced.ok) {
      const { message: why, cause } = priced.error;
      const error = cause === undefined ? why : `${why} (${message(cause)})`;
      pairs.push({ sellAsset, buyAsset, error });
      errors.push(`${sellAsset} -> ${buyAsset}: ${error}`);
      continue;
    }
    const rate = priced.value.price.rate;
    try {
      const recorded = await ctx.store.record({
        network: ctx.network,
        sellAsset,
        buyAsset,
        source: "sep38_price",
        anchorDomain: domain,
        rate,
        sampledAt: ctx.now(),
        detail: {
          referenceAmount: ctx.referenceAmount,
          buyAmount: priced.value.destAmount,
          context,
        },
      });
      pairs.push({ sellAsset, buyAsset, rate, recorded });
    } catch (e) {
      const error = `not stored: ${message(e)}`;
      pairs.push({ sellAsset, buyAsset, rate, error });
      errors.push(`${sellAsset} -> ${buyAsset}: ${error}`);
    }
  }

  const stored = pairs.filter((p) => p.error === undefined).length;
  // An anchor that listed no pairs and met no error is fine; one that met errors and stored
  // nothing has failed this run.
  const status = errors.length === 0 ? "ok" : stored > 0 ? "partial" : "failed";
  return { domain, quoteServer, status, pairs, errors };
}

/**
 * Run one collection: poll every attested SEP-38 anchor (and any named in `anchors`), and
 * write one `sep38_price` sample per listed pair. Anchors are polled concurrently; requests to
 * one anchor are made one at a time.
 *
 * Throws only for invalid options. A registry, anchor, pair or store failure is reported in
 * the result instead.
 */
export async function pollSep38Prices(
  options: PollSep38PricesOptions,
): Promise<Sep38PollResult> {
  if (!RATE_NETWORKS.includes(options.network)) {
    throw new RangeError(
      `network must be testnet or public, got ${JSON.stringify(options.network)}`,
    );
  }
  const referenceAmount = options.referenceAmount ?? DEFAULT_SEP38_REFERENCE_AMOUNT;
  if (!isSettleableAmount(referenceAmount)) {
    throw new RangeError(
      `referenceAmount must be a positive decimal string, got ${JSON.stringify(referenceAmount)}`,
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_SEP38_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive integer");
  }
  if (options.sellAssets) assertSellAssets(options.sellAssets, "sellAssets");

  const targets = new Map<string, Sep38PollTarget>();
  for (const a of options.anchors ?? []) {
    const target = typeof a === "string" ? { domain: a } : a;
    if (target.sellAssets)
      assertSellAssets(target.sellAssets, `sellAssets for ${target.domain}`);
    targets.set(target.domain, target);
  }

  const logger = options.logger ?? silentLogger;
  let skipped: Sep38SkippedAnchor[] = [];
  let registryError: string | undefined;
  if (options.registry) {
    try {
      const found = await findSep38Anchors(options.registry, options.maxStalenessLedgers);
      skipped = found.skipped;
      for (const domain of found.domains) {
        if (!targets.has(domain)) targets.set(domain, { domain });
      }
    } catch (e) {
      registryError = `registry domains could not be read: ${message(e)}`;
      logger.log("warn", "corridor.rate_collector.sep38.registry_failed", {
        error: registryError,
      });
    }
  }

  const ctx: AnchorPollContext = {
    network: options.network,
    store: options.store,
    sellAssets: options.sellAssets,
    referenceAmount,
    timeoutMs,
    fetchImpl: options.fetch ?? fetch,
    now: options.now ?? Date.now,
  };

  logger.log("info", "corridor.rate_collector.sep38.run_started", {
    anchors: [...targets.keys()],
  });
  const anchors = await Promise.all([...targets.values()].map((t) => pollAnchor(t, ctx)));

  let recorded = 0;
  let duplicates = 0;
  let anchorsFailed = 0;
  for (const anchor of anchors) {
    for (const pair of anchor.pairs) {
      if (pair.recorded === true) recorded++;
      else if (pair.recorded === false) duplicates++;
    }
    if (anchor.status === "failed") anchorsFailed++;
    if (anchor.errors.length > 0) {
      logger.log("warn", "corridor.rate_collector.sep38.anchor_errors", {
        domain: anchor.domain,
        status: anchor.status,
        errors: anchor.errors,
      });
    }
  }
  logger.log("info", "corridor.rate_collector.sep38.run_completed", {
    anchors: anchors.length,
    anchorsFailed,
    recorded,
    duplicates,
  });

  return {
    anchors,
    skipped,
    ...(registryError ? { registryError } : {}),
    recorded,
    duplicates,
    anchorsFailed,
  };
}
