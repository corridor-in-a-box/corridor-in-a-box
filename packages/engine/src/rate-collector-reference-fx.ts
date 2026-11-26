// Rate history collector for a public reference FX rate. RFC 0004 §3, issue #592.
//
// To tell whether an anchor's price is fair we need a public rate for the same
// currencies, such as USD/NGN. docs/reference-fx-sources.md compares the sources
// whose terms we read and records the choice: Currency-api (CC0), checked against
// the ECB euro reference rates where the ECB has the currency. This step reads
// Currency-api's daily file for each configured base currency and writes one
// `reference_fx` sample per pair per day into the rate history store
// (`rate-samples-pg.ts`):
//
// - sell asset = `iso4217:<base>`, buy asset = `iso4217:<quote>`, so the stored
//   rate is "quote units per one base unit", which is what the file gives;
// - the rate is the number as it is written in the file, taken from the response
//   text and stored verbatim. The body is never run through `JSON.parse` for its
//   rates, so no float rounding gets between the source and the stored value;
// - the source publishes one value per day, so the sample's instant is 00:00 UTC
//   of the file's own `date`. Reading the same day again stores nothing;
// - a reference rate belongs to no anchor, so `anchorDomain` is always null;
// - where the ECB lists both currencies, the sample's `detail.ecb` says whether
//   the two sources agree. A sample that differs is still stored: it is marked,
//   not hidden. Where the ECB has no rate (NGN, KES) the sample says "unchecked".
//
// A reference rate is used to judge prices after the fact. It must never price
// or route a payment.

import { readFileSync } from "node:fs";
import {
  RATE_NETWORKS,
  type RateNetwork,
  type RateSampleInput,
  type PostgresRateHistoryStore,
} from "./rate-samples-pg";

/** One pair to watch: the rate stored is `quote` units per one `base` unit. ISO 4217 codes. */
export interface ReferenceFxPairConfig {
  base: string;
  quote: string;
}

/** The ECB's daily file: euro reference rates, one `<Cube currency rate>` per currency. */
export const ECB_DAILY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

/**
 * How far the two sources may differ before a sample is marked `differs`, in
 * basis points. The two publish at different times of day, so some distance is
 * normal; 2% is far more than a day's move in these currencies usually is.
 */
export const DEFAULT_ECB_MARGIN_BPS = 200;

/**
 * How many days apart the two files' dates may be for the check to mean
 * anything. The ECB does not publish on weekends or its holidays, so its latest
 * file can be a few days older than Currency-api's.
 */
export const ECB_MAX_DATE_GAP_DAYS = 4;

const DAY_MS = 24 * 60 * 60 * 1000;
const CURRENCY_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_RE = /^\d+(?:\.\d+)?$/;
/** A JSON number: optional sign, digits, optional fraction, optional exponent. */
const JSON_NUMBER = String.raw`-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`;

export interface CollectReferenceFxOptions {
  /** The file to read: `latest` (default) or a `YYYY-MM-DD` day. */
  date?: string;
  /** Overrides the hosts tried, in order. Each gets `{date}` and `{base}` filled in. */
  urlTemplates?: readonly string[];
  /** Set false to skip the ECB check. Samples then carry no `detail.ecb`. */
  ecbCheck?: boolean;
  ecbUrl?: string;
  ecbMarginBps?: number;
  fetch?: typeof fetch;
}

/** Where samples go: the rate history store, or anything with the same `record`. */
export type ReferenceFxSampleSink = Pick<PostgresRateHistoryStore, "record">;

/**
 * Currency-api's two hosts, in the order its README asks callers to try them:
 * the jsDelivr CDN, then the Cloudflare Pages mirror.
 */
export const CURRENCY_API_URL_TEMPLATES: readonly string[] = [
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@{date}/v1/currencies/{base}.json",
  "https://{date}.currency-api.pages.dev/v1/currencies/{base}.json",
];

/** Rejects a pair the store would refuse or the source cannot answer. */
export function assertReferenceFxPair(pair: ReferenceFxPairConfig): void {
  for (const field of ["base", "quote"] as const) {
    const code = pair[field];
    if (typeof code !== "string" || !CURRENCY_RE.test(code)) {
      throw new RangeError(
        `${field} must be an ISO 4217 code in upper case, got ${JSON.stringify(code)}`,
      );
    }
  }
  if (pair.base === pair.quote) {
    throw new RangeError(`base and quote are the same currency (${pair.base})`);
  }
}

function assertDate(date: string): void {
  if (date !== "latest" && !DATE_RE.test(date)) {
    throw new RangeError(`date must be "latest" or YYYY-MM-DD, got ${JSON.stringify(date)}`);
  }
}

/** The URLs to try for one base currency's file, in order. */
export function currencyApiUrls(
  base: string,
  options: Pick<CollectReferenceFxOptions, "date" | "urlTemplates"> = {},
): string[] {
  if (!CURRENCY_RE.test(base)) {
    throw new RangeError(
      `base must be an ISO 4217 code in upper case, got ${JSON.stringify(base)}`,
    );
  }
  const date = options.date ?? "latest";
  assertDate(date);
  return (options.urlTemplates ?? CURRENCY_API_URL_TEMPLATES).map((template) =>
    template.replaceAll("{date}", date).replaceAll("{base}", base.toLowerCase()),
  );
}

/** Drops trailing zeros without a regex: a `/0+$/` on text from the network can backtrack. */
function dropTrailingZeros(digits: string): string {
  let end = digits.length;
  while (end > 0 && digits.charCodeAt(end - 1) === 48) end -= 1;
  return digits.slice(0, end);
}

/** Drops leading zeros, keeping the last digit, so "000" becomes "0". */
function dropLeadingZeros(digits: string): string {
  let start = 0;
  while (start < digits.length - 1 && digits.charCodeAt(start) === 48) start += 1;
  return digits.slice(start);
}

/**
 * Writes a JSON number literal as a plain decimal string, digit for digit:
 * `1.5e-7` becomes `0.00000015`, `1650.25` stays `1650.25`. Returns null for
 * anything that is not a JSON number. No float is involved.
 */
export function plainDecimal(literal: string): string | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(literal.trim());
  if (!m) return null;
  const [, sign, int, frac = "", exp = "0"] = m;
  const shift = Number(exp);
  if (!Number.isSafeInteger(shift) || Math.abs(shift) > 400) return null;
  const digits = int + frac;
  // Where the decimal point sits, counted from the left of `digits`.
  const point = int!.length + shift;
  let whole: string;
  let part: string;
  if (point <= 0) {
    whole = "0";
    part = "0".repeat(-point) + digits;
  } else if (point >= digits.length) {
    whole = digits + "0".repeat(point - digits.length);
    part = "";
  } else {
    whole = digits.slice(0, point);
    part = digits.slice(point);
  }
  whole = dropLeadingZeros(whole);
  part = dropTrailingZeros(part);
  return `${sign}${whole}${part ? `.${part}` : ""}`;
}

/** One base currency's file, as far as this step reads it. */
export interface CurrencyApiFile {
  /** The day the rates are for, `YYYY-MM-DD`, from the file itself. */
  date: string;
  /** Quote code (upper case) to its rate, as the decimal written in the file. */
  rates: Map<string, string>;
  /** The URL that answered. */
  url: string;
}

/**
 * Reads the rates of the wanted quote currencies out of a Currency-api file's
 * text: `{"date":"2026-11-26","usd":{"ngn":1650.25,...}}`. Each rate is taken as
 * the characters written in the file. Throws when the file has no usable date or
 * no object for the base; a quote the file does not list is simply absent.
 */
export function parseCurrencyApiFile(
  text: string,
  base: string,
  quotes: readonly string[],
): Omit<CurrencyApiFile, "url"> {
  const date = /"date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/.exec(text)?.[1];
  if (!date) throw new Error("Currency-api file has no date");
  const opened = new RegExp(`"${base.toLowerCase()}"\\s*:\\s*\\{`).exec(text);
  if (!opened) throw new Error(`Currency-api file has no rates for ${base}`);
  const start = opened.index + opened[0].length;
  // The base's object holds only code-to-number pairs, so it ends at the next brace.
  const end = text.indexOf("}", start);
  const body = text.slice(start, end === -1 ? undefined : end);
  const rates = new Map<string, string>();
  for (const quote of quotes) {
    const literal = new RegExp(`"${quote.toLowerCase()}"\\s*:\\s*(${JSON_NUMBER})`).exec(
      body,
    )?.[1];
    if (literal === undefined) continue;
    const rate = plainDecimal(literal);
    // The store needs a positive rate; zero or a negative carries no price.
    if (rate === null || !DECIMAL_RE.test(rate) || !/[1-9]/.test(rate)) continue;
    rates.set(quote, rate);
  }
  return { date, rates };
}

/** Fetches one base currency's file, trying each host in turn. Throws when every host fails. */
export async function fetchCurrencyApiFile(
  base: string,
  quotes: readonly string[],
  options: CollectReferenceFxOptions = {},
): Promise<CurrencyApiFile> {
  const failures: string[] = [];
  for (const url of currencyApiUrls(base, options)) {
    try {
      const res = await (options.fetch ?? fetch)(url, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        failures.push(`HTTP ${res.status} for ${url}`);
        continue;
      }
      return { ...parseCurrencyApiFile(await res.text(), base, quotes), url };
    } catch (e) {
      failures.push(`${(e as Error).message} for ${url}`);
    }
  }
  throw new Error(`Currency-api failed on every host: ${failures.join("; ")}`);
}

/** The ECB's daily file: its day and each currency's units per one euro. */
export interface EcbDailyRates {
  date: string;
  /** Currency code to units per one euro, as written. EUR itself is `"1"`. */
  perEuro: Map<string, string>;
}

/** Reads the ECB daily XML. Throws when it has no dated cube. */
export function parseEcbDaily(xml: string): EcbDailyRates {
  const date = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1];
  if (!date) throw new Error("ECB daily file has no dated rates");
  const perEuro = new Map<string, string>([["EUR", "1"]]);
  for (const m of xml.matchAll(
    /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]/g,
  )) {
    if (DECIMAL_RE.test(m[2]!) && /[1-9]/.test(m[2]!)) perEuro.set(m[1]!, m[2]!);
  }
  return { date, perEuro };
}

export async function fetchEcbDaily(
  options: CollectReferenceFxOptions = {},
): Promise<EcbDailyRates> {
  const url = options.ecbUrl ?? ECB_DAILY_URL;
  const res = await (options.fetch ?? fetch)(url, { headers: { accept: "application/xml" } });
  if (!res.ok) throw new Error(`ECB daily rates failed: HTTP ${res.status} for ${url}`);
  return parseEcbDaily(await res.text());
}

const SCALE_DIGITS = 18;
const SCALE = 10n ** BigInt(SCALE_DIGITS);

/** A positive decimal string as an integer scaled by 10^18. Digits past the 18th are dropped. */
function scaled(decimal: string): bigint {
  const [whole, frac = ""] = decimal.split(".");
  return (
    BigInt(whole!) * SCALE + BigInt(frac.slice(0, SCALE_DIGITS).padEnd(SCALE_DIGITS, "0"))
  );
}

function unscaled(value: bigint): string {
  const whole = value / SCALE;
  const frac = dropTrailingZeros((value % SCALE).toString().padStart(SCALE_DIGITS, "0"));
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** What the ECB check found for one sample. Stored in the sample's `detail.ecb`. */
export type EcbCheck =
  | {
      status: "agrees" | "differs";
      /** The ECB's rate for the pair, crossed through the euro, cut at 8 decimal places. */
      crossRate: string;
      /** How far the sample is from it, in whole basis points, rounded down. */
      deviationBps: number;
      marginBps: number;
      ecbDate: string;
    }
  | {
      status: "unchecked";
      /** Why: the ECB lists no rate for one side, its file is too old, or it could not be read. */
      reason: "currency_not_listed" | "dates_too_far_apart" | "ecb_unavailable";
      ecbDate?: string;
    };

/**
 * Compares one rate with the ECB's cross rate for the same pair. All integer
 * arithmetic on scaled values: the result does not depend on float rounding.
 */
export function checkAgainstEcb(
  pair: ReferenceFxPairConfig,
  rate: string,
  date: string,
  ecb: EcbDailyRates | null,
  marginBps: number = DEFAULT_ECB_MARGIN_BPS,
): EcbCheck {
  if (!Number.isInteger(marginBps) || marginBps < 0) {
    throw new RangeError("ecbMarginBps must be a non-negative integer");
  }
  if (!ecb) return { status: "unchecked", reason: "ecb_unavailable" };
  const basePerEuro = ecb.perEuro.get(pair.base);
  const quotePerEuro = ecb.perEuro.get(pair.quote);
  if (!basePerEuro || !quotePerEuro) {
    return { status: "unchecked", reason: "currency_not_listed", ecbDate: ecb.date };
  }
  const gapDays =
    Math.abs(Date.parse(`${date}T00:00:00Z`) - Date.parse(`${ecb.date}T00:00:00Z`)) / DAY_MS;
  if (!(gapDays <= ECB_MAX_DATE_GAP_DAYS)) {
    return { status: "unchecked", reason: "dates_too_far_apart", ecbDate: ecb.date };
  }
  // quote per base = (quote per euro) / (base per euro).
  const cross = (scaled(quotePerEuro) * SCALE) / scaled(basePerEuro);
  const ours = scaled(rate);
  const distance = ours > cross ? ours - cross : cross - ours;
  const deviationBps = Number((distance * 10_000n) / cross);
  // Eight decimal places is more than either source publishes.
  const crossRate = unscaled((cross / 10n ** 10n) * 10n ** 10n);
  return {
    status: deviationBps > marginBps ? "differs" : "agrees",
    crossRate,
    deviationBps,
    marginBps,
    ecbDate: ecb.date,
  };
}

/** Turns one base currency's file into `reference_fx` samples for the pairs that share that base. */
export function referenceFxSamples(
  file: Omit<CurrencyApiFile, "url"> & { url?: string },
  pairs: readonly ReferenceFxPairConfig[],
  network: RateNetwork,
  ecb?: { rates: EcbDailyRates | null; marginBps?: number },
): RateSampleInput[] {
  const samples: RateSampleInput[] = [];
  for (const pair of pairs) {
    const rate = file.rates.get(pair.quote);
    if (rate === undefined) continue;
    samples.push({
      network,
      sellAsset: `iso4217:${pair.base}`,
      buyAsset: `iso4217:${pair.quote}`,
      source: "reference_fx",
      anchorDomain: null,
      rate,
      // The source gives one value for the day, with no time of day.
      sampledAt: Date.parse(`${file.date}T00:00:00Z`),
      detail: {
        provider: "currency-api",
        date: file.date,
        ...(file.url !== undefined && { url: file.url }),
        ...(ecb && { ecb: checkAgainstEcb(pair, rate, file.date, ecb.rates, ecb.marginBps) }),
      },
    });
  }
  return samples;
}

export interface ReferenceFxResult {
  samples: RateSampleInput[];
  /** How many samples were new to the store (0 without a sink). */
  inserted: number;
  /** Pairs the source had no usable rate for. Reported, never guessed. */
  missing: ReferenceFxPairConfig[];
  /** Set when the ECB file could not be read. The samples are stored anyway, as "unchecked". */
  ecbError?: string;
}

/**
 * Collects every pair and, given a sink, stores the samples. One file is read
 * per base currency. A base whose file cannot be read on any host stops the
 * run, so nothing is silently skipped; the ECB failing does not, because it is
 * a check on the rate and not the rate.
 */
export async function collectReferenceFx(
  pairs: readonly ReferenceFxPairConfig[],
  network: RateNetwork,
  sink?: ReferenceFxSampleSink,
  options: CollectReferenceFxOptions = {},
): Promise<ReferenceFxResult> {
  if (!(RATE_NETWORKS as readonly string[]).includes(network)) {
    throw new RangeError(`network must be one of ${RATE_NETWORKS.join(", ")}`);
  }
  for (const pair of pairs) assertReferenceFxPair(pair);

  let ecb: { rates: EcbDailyRates | null; marginBps?: number } | undefined;
  let ecbError: string | undefined;
  if (options.ecbCheck !== false && pairs.length > 0) {
    try {
      ecb = { rates: await fetchEcbDaily(options), marginBps: options.ecbMarginBps };
    } catch (e) {
      ecbError = (e as Error).message;
      ecb = { rates: null, marginBps: options.ecbMarginBps };
    }
  }

  const byBase = new Map<string, ReferenceFxPairConfig[]>();
  for (const pair of pairs) byBase.set(pair.base, [...(byBase.get(pair.base) ?? []), pair]);

  const samples: RateSampleInput[] = [];
  const missing: ReferenceFxPairConfig[] = [];
  for (const [base, basePairs] of byBase) {
    const file = await fetchCurrencyApiFile(
      base,
      basePairs.map((p) => p.quote),
      options,
    );
    samples.push(...referenceFxSamples(file, basePairs, network, ecb));
    missing.push(...basePairs.filter((p) => !file.rates.has(p.quote)));
  }

  let inserted = 0;
  if (sink) {
    for (const sample of samples) {
      if (await sink.record(sample)) inserted++;
    }
  }
  return { samples, inserted, missing, ...(ecbError !== undefined && { ecbError }) };
}

/** Parses and checks a pairs config: a JSON array of `{ base, quote }`. */
export function parseReferenceFxPairsConfig(raw: unknown): ReferenceFxPairConfig[] {
  if (!Array.isArray(raw))
    throw new RangeError("Reference FX pairs config must be a JSON array");
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new RangeError(`Reference FX pair ${i} must be an object`);
    }
    const { base, quote } = entry as Record<string, unknown>;
    const pair = { base, quote } as ReferenceFxPairConfig;
    try {
      assertReferenceFxPair(pair);
    } catch (e) {
      throw new RangeError(`Reference FX pair ${i}: ${(e as Error).message}`, { cause: e });
    }
    const key = `${pair.base}/${pair.quote}`;
    if (seen.has(key)) throw new RangeError(`Reference FX pair ${i}: ${key} is listed twice`);
    seen.add(key);
    return pair;
  });
}

/** Reads `config/reference-fx-pairs.json` (or another path) and checks every pair. */
export function loadReferenceFxPairsConfig(path: string): ReferenceFxPairConfig[] {
  return parseReferenceFxPairsConfig(JSON.parse(readFileSync(path, "utf8")));
}
