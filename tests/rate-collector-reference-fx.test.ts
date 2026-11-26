// Reference FX collector (#592). The two files under tests/fixtures/ were recorded on
// 2026-11-26 from https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json
// and https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml. No test touches the network.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURRENCY_API_URL_TEMPLATES,
  DEFAULT_ECB_MARGIN_BPS,
  ECB_DAILY_URL,
  PostgresRateHistoryStore,
  checkAgainstEcb,
  collectReferenceFx,
  currencyApiUrls,
  loadReferenceFxPairsConfig,
  parseCurrencyApiFile,
  parseEcbDaily,
  parseReferenceFxPairsConfig,
  plainDecimal,
  referenceFxSamples,
  type EcbCheck,
  type Queryable,
  type ReferenceFxPairConfig,
} from "@corridor/engine";

const fixture = (name: string): string =>
  readFileSync(resolve(process.cwd(), "tests/fixtures", name), "utf8");

const USD_FILE = fixture("currency-api-usd.json");
const ECB_FILE = fixture("ecb-eurofxref-daily.xml");
const DAY = Date.parse("2026-11-26T00:00:00Z");

const PAIRS: ReferenceFxPairConfig[] = ["NGN", "ZAR", "MXN", "PHP", "KES"].map((quote) => ({
  base: "USD",
  quote,
}));

const JSDELIVR =
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json";
const PAGES = "https://latest.currency-api.pages.dev/v1/currencies/usd.json";

/** A fetch that answers from a table of URL to body (or status) and remembers what it was asked. */
function stubFetch(table: Record<string, string | number | Error>) {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const answer = table[url];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) return new Response("not found", { status: 404 });
    if (typeof answer === "number") return new Response("failed", { status: answer });
    return new Response(answer, { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

/** The real store over a fake database: every sample goes through its validation. */
function recordingStore(stored = true) {
  const inserts: unknown[][] = [];
  const db: Queryable = {
    async query<R>(_text: string, params?: unknown[]) {
      inserts.push(params ?? []);
      return { rows: (stored ? [{ id: String(inserts.length) }] : []) as R[] };
    },
  };
  return { store: new PostgresRateHistoryStore(db), inserts };
}

const ecbOf = (sample: { detail?: Record<string, unknown> | null }) =>
  sample.detail?.ecb as EcbCheck;

describe("plainDecimal", () => {
  it.each([
    ["1354.59233772", "1354.59233772"],
    ["17", "17"],
    ["0.5", "0.5"],
    ["1.5e-7", "0.00000015"],
    ["1.5E+3", "1500"],
    ["12.345e1", "123.45"],
    ["1e0", "1"],
    ["0.000100", "0.0001"],
    ["007.50", "7.5"],
    ["-2.5e1", "-25"],
  ])("writes %s as %s, digit for digit", (literal, plain) => {
    expect(plainDecimal(literal)).toBe(plain);
  });

  it.each(["", "abc", "1.2.3", "1e", ".5", "NaN", "1e999"])("refuses %j", (literal) => {
    expect(plainDecimal(literal)).toBeNull();
  });

  it("keeps digits a float cannot hold", () => {
    expect(plainDecimal("1354.592337720000000001")).toBe("1354.592337720000000001");
    expect(plainDecimal("9007199254740993")).toBe("9007199254740993");
  });
});

describe("parseCurrencyApiFile", () => {
  it("reads the recorded file's date and the rates as they are written", () => {
    const file = parseCurrencyApiFile(USD_FILE, "USD", ["NGN", "ZAR", "MXN", "PHP", "KES"]);
    expect(file.date).toBe("2026-11-26");
    expect(Object.fromEntries(file.rates)).toEqual({
      NGN: "1354.59233772",
      ZAR: "17.48913345",
      MXN: "19.5664259",
      PHP: "63.71690211",
      KES: "130.25508743",
    });
  });

  it("leaves out a currency the file does not list, and one whose rate is not a positive number", () => {
    const text = '{"date":"2026-11-26","usd":{"ngn":1650.25,"zar":0,"mxn":-1,"php":"n/a"}}';
    const file = parseCurrencyApiFile(text, "USD", ["NGN", "ZAR", "MXN", "PHP", "KES"]);
    expect(Object.fromEntries(file.rates)).toEqual({ NGN: "1650.25" });
  });

  it("does not take a rate from outside the base's object, or from a longer code", () => {
    const text = '{"date":"2026-11-26","usd":{"xngn":5,"zar":17.5},"other":{"ngn":999}}';
    const file = parseCurrencyApiFile(text, "USD", ["NGN", "ZAR"]);
    expect(Object.fromEntries(file.rates)).toEqual({ ZAR: "17.5" });
  });

  it("expands an exponent without rounding", () => {
    const file = parseCurrencyApiFile('{"date":"2026-11-26","usd":{"btc":1.0425e-5}}', "USD", [
      "BTC",
    ]);
    expect(file.rates.get("BTC")).toBe("0.000010425");
  });

  it("refuses a file with no date or no rates for the base", () => {
    expect(() => parseCurrencyApiFile('{"usd":{"ngn":1}}', "USD", ["NGN"])).toThrow(/no date/);
    expect(() =>
      parseCurrencyApiFile('{"date":"2026-11-26","eur":{"ngn":1}}', "USD", ["NGN"]),
    ).toThrow(/no rates for USD/);
  });
});

describe("currencyApiUrls", () => {
  it("tries jsDelivr first and the Pages mirror second, as the source's README asks", () => {
    expect(currencyApiUrls("USD")).toEqual([JSDELIVR, PAGES]);
    expect(CURRENCY_API_URL_TEMPLATES).toHaveLength(2);
  });

  it("names a day when one is given", () => {
    expect(currencyApiUrls("USD", { date: "2026-11-20" })).toEqual([
      "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@2026-11-20/v1/currencies/usd.json",
      "https://2026-11-20.currency-api.pages.dev/v1/currencies/usd.json",
    ]);
  });

  it("refuses a base or a date that could change the URL's shape", () => {
    expect(() => currencyApiUrls("usd")).toThrow(RangeError);
    expect(() => currencyApiUrls("US/")).toThrow(RangeError);
    expect(() => currencyApiUrls("USD", { date: "../x" })).toThrow(RangeError);
    expect(() => currencyApiUrls("USD", { date: "2026-1-1" })).toThrow(RangeError);
  });
});

describe("parseEcbDaily", () => {
  it("reads the recorded file's date and rates per euro", () => {
    const ecb = parseEcbDaily(ECB_FILE);
    expect(ecb.date).toBe("2026-11-26");
    expect(ecb.perEuro.get("EUR")).toBe("1");
    expect(ecb.perEuro.get("USD")).toBe("1.0975");
    expect(ecb.perEuro.get("ZAR")).toBe("19.2646");
    expect(ecb.perEuro.get("MXN")).toBe("21.5893");
    expect(ecb.perEuro.get("PHP")).toBe("69.935");
    // The reason NGN and KES rest on one source.
    expect(ecb.perEuro.has("NGN")).toBe(false);
    expect(ecb.perEuro.has("KES")).toBe(false);
  });

  it("refuses a file with no dated rates", () => {
    expect(() => parseEcbDaily("<Envelope></Envelope>")).toThrow(/no dated rates/);
  });
});

describe("checkAgainstEcb", () => {
  const ecb = parseEcbDaily(ECB_FILE);
  const pair = (quote: string): ReferenceFxPairConfig => ({ base: "USD", quote });

  it("crosses through the euro and reports the distance in whole basis points", () => {
    // ZAR per USD at the ECB: 19.2646 / 1.0975 = 17.55316628...; the sample is 17.48913345.
    expect(checkAgainstEcb(pair("ZAR"), "17.48913345", "2026-11-26", ecb)).toEqual({
      status: "agrees",
      crossRate: "17.55316628",
      deviationBps: 36,
      marginBps: DEFAULT_ECB_MARGIN_BPS,
      ecbDate: "2026-11-26",
    });
    // MXN: 21.5893 / 1.0975 = 19.67134396...; PHP: 69.935 / 1.0975 = 63.72209567...
    expect(checkAgainstEcb(pair("MXN"), "19.5664259", "2026-11-26", ecb)).toMatchObject({
      status: "agrees",
      crossRate: "19.67134396",
      deviationBps: 53,
    });
    expect(checkAgainstEcb(pair("PHP"), "63.71690211", "2026-11-26", ecb)).toMatchObject({
      status: "agrees",
      crossRate: "63.72209567",
      deviationBps: 0,
    });
  });

  it("marks a rate on the margin as agreeing and one past it as differing, on either side", () => {
    // The cross is exactly 20 when ZAR is 21.95 per euro: 21.95 / 1.0975.
    const round = {
      date: "2026-11-26",
      perEuro: new Map([
        ["USD", "1.0975"],
        ["ZAR", "21.95"],
      ]),
    };
    expect(checkAgainstEcb(pair("ZAR"), "20.4", "2026-11-26", round)).toMatchObject({
      status: "agrees",
      crossRate: "20",
      deviationBps: 200,
    });
    expect(checkAgainstEcb(pair("ZAR"), "20.402", "2026-11-26", round)).toMatchObject({
      status: "differs",
      deviationBps: 201,
    });
    expect(checkAgainstEcb(pair("ZAR"), "19.598", "2026-11-26", round)).toMatchObject({
      status: "differs",
      deviationBps: 201,
    });
    expect(checkAgainstEcb(pair("ZAR"), "20.402", "2026-11-26", round, 250).status).toBe(
      "agrees",
    );
  });

  it("works for a pair whose base is not the dollar, and for the euro itself", () => {
    expect(
      checkAgainstEcb({ base: "EUR", quote: "ZAR" }, "19.2646", "2026-11-26", ecb),
    ).toMatchObject({
      status: "agrees",
      crossRate: "19.2646",
      deviationBps: 0,
    });
    // USD per ZAR: 1.0975 / 19.2646 = 0.0569697787..., cut (not rounded) at eight places.
    expect(
      checkAgainstEcb({ base: "ZAR", quote: "USD" }, "0.057", "2026-11-26", ecb),
    ).toMatchObject({
      status: "agrees",
      crossRate: "0.05696977",
    });
  });

  it("says unchecked, with the reason, when it cannot compare", () => {
    expect(checkAgainstEcb(pair("NGN"), "1354.59233772", "2026-11-26", ecb)).toEqual({
      status: "unchecked",
      reason: "currency_not_listed",
      ecbDate: "2026-11-26",
    });
    expect(checkAgainstEcb(pair("ZAR"), "17.5", "2026-11-26", null)).toEqual({
      status: "unchecked",
      reason: "ecb_unavailable",
    });
    // Four days apart is a long weekend; five is a stale file.
    expect(checkAgainstEcb(pair("ZAR"), "17.5", "2026-11-30", ecb).status).toBe("agrees");
    expect(checkAgainstEcb(pair("ZAR"), "17.5", "2026-12-01", ecb)).toEqual({
      status: "unchecked",
      reason: "dates_too_far_apart",
      ecbDate: "2026-11-26",
    });
  });

  it("refuses a margin that is not a non-negative integer", () => {
    expect(() => checkAgainstEcb(pair("ZAR"), "17.5", "2026-11-26", ecb, -1)).toThrow(
      RangeError,
    );
    expect(() => checkAgainstEcb(pair("ZAR"), "17.5", "2026-11-26", ecb, 1.5)).toThrow(
      RangeError,
    );
  });
});

describe("referenceFxSamples", () => {
  it("writes one reference_fx sample per pair at 00:00 UTC of the file's day", () => {
    const file = parseCurrencyApiFile(USD_FILE, "USD", ["NGN"]);
    expect(
      referenceFxSamples(
        { ...file, url: JSDELIVR },
        [{ base: "USD", quote: "NGN" }],
        "public",
      ),
    ).toEqual([
      {
        network: "public",
        sellAsset: "iso4217:USD",
        buyAsset: "iso4217:NGN",
        source: "reference_fx",
        anchorDomain: null,
        rate: "1354.59233772",
        sampledAt: DAY,
        detail: { provider: "currency-api", date: "2026-11-26", url: JSDELIVR },
      },
    ]);
  });

  it("skips a pair the file has no rate for", () => {
    const file = parseCurrencyApiFile(USD_FILE, "USD", ["NGN", "XXX"]);
    const samples = referenceFxSamples(
      file,
      [
        { base: "USD", quote: "XXX" },
        { base: "USD", quote: "NGN" },
      ],
      "testnet",
    );
    expect(samples.map((s) => s.buyAsset)).toEqual(["iso4217:NGN"]);
  });
});

describe("collectReferenceFx", () => {
  it("stores the five pairs from the recorded files, each with its ECB check", async () => {
    const { fetchImpl, urls } = stubFetch({ [JSDELIVR]: USD_FILE, [ECB_DAILY_URL]: ECB_FILE });
    const { store, inserts } = recordingStore();

    const result = await collectReferenceFx(PAIRS, "public", store, { fetch: fetchImpl });

    // One request for the ECB and one for the dollar file, whatever the number of pairs.
    expect(urls).toEqual([ECB_DAILY_URL, JSDELIVR]);
    expect(result.inserted).toBe(5);
    expect(result.missing).toEqual([]);
    expect(result.ecbError).toBeUndefined();
    expect(result.samples.map((s) => [s.buyAsset, s.rate, ecbOf(s).status])).toEqual([
      ["iso4217:NGN", "1354.59233772", "unchecked"],
      ["iso4217:ZAR", "17.48913345", "agrees"],
      ["iso4217:MXN", "19.5664259", "agrees"],
      ["iso4217:PHP", "63.71690211", "agrees"],
      ["iso4217:KES", "130.25508743", "unchecked"],
    ]);
    for (const sample of result.samples) {
      expect(sample).toMatchObject({
        network: "public",
        sellAsset: "iso4217:USD",
        source: "reference_fx",
        anchorDomain: null,
        sampledAt: DAY,
      });
    }

    // What reached the database: no anchor, no run id, the rate as a string.
    expect(inserts).toHaveLength(5);
    const [network, sell, buy, source, anchor, rate, at, runId, outlier, detail] = inserts[0]!;
    expect([network, sell, buy, source, anchor, rate, at, runId, outlier]).toEqual([
      "public",
      "iso4217:USD",
      "iso4217:NGN",
      "reference_fx",
      null,
      "1354.59233772",
      "2026-11-26T00:00:00.000Z",
      null,
      false,
    ]);
    expect(JSON.parse(detail as string)).toEqual({
      provider: "currency-api",
      date: "2026-11-26",
      url: JSDELIVR,
      ecb: { status: "unchecked", reason: "currency_not_listed", ecbDate: "2026-11-26" },
    });
  });

  it("counts nothing as new when the day is already stored", async () => {
    const { fetchImpl } = stubFetch({ [JSDELIVR]: USD_FILE, [ECB_DAILY_URL]: ECB_FILE });
    const { store } = recordingStore(false);
    const result = await collectReferenceFx(PAIRS, "public", store, { fetch: fetchImpl });
    expect(result.samples).toHaveLength(5);
    expect(result.inserted).toBe(0);
  });

  it("falls back to the second host when the first fails, and records which one answered", async () => {
    for (const failure of [503, new Error("socket hang up")] as const) {
      const { fetchImpl, urls } = stubFetch({
        [JSDELIVR]: failure,
        [PAGES]: USD_FILE,
        [ECB_DAILY_URL]: ECB_FILE,
      });
      const result = await collectReferenceFx(PAIRS, "testnet", undefined, {
        fetch: fetchImpl,
      });
      expect(urls).toEqual([ECB_DAILY_URL, JSDELIVR, PAGES]);
      expect(result.samples).toHaveLength(5);
      expect(result.samples[0]!.detail).toMatchObject({ url: PAGES });
    }
  });

  it("fails, and stores nothing, when both hosts fail", async () => {
    const { fetchImpl } = stubFetch({
      [JSDELIVR]: 500,
      [PAGES]: 502,
      [ECB_DAILY_URL]: ECB_FILE,
    });
    const { store, inserts } = recordingStore();
    await expect(
      collectReferenceFx(PAIRS, "public", store, { fetch: fetchImpl }),
    ).rejects.toThrow(/Currency-api failed on every host: HTTP 500 for .*; HTTP 502 for /);
    expect(inserts).toEqual([]);
  });

  it("still stores the rates, as unchecked, when the ECB cannot be read", async () => {
    const { fetchImpl } = stubFetch({ [JSDELIVR]: USD_FILE, [ECB_DAILY_URL]: 503 });
    const { store } = recordingStore();

    const result = await collectReferenceFx(PAIRS, "public", store, { fetch: fetchImpl });

    expect(result.inserted).toBe(5);
    expect(result.ecbError).toMatch(/ECB daily rates failed: HTTP 503/);
    expect(result.samples.map((s) => ecbOf(s))).toEqual(
      PAIRS.map(() => ({ status: "unchecked", reason: "ecb_unavailable" })),
    );
  });

  it("marks a sample that differs from the ECB, and still stores it", async () => {
    // The same day, with the rand 5% away from the ECB cross rate.
    const moved = USD_FILE.replace(/"zar":\s*17\.48913345/, '"zar": 18.43');
    expect(moved).not.toBe(USD_FILE);
    const { fetchImpl } = stubFetch({ [JSDELIVR]: moved, [ECB_DAILY_URL]: ECB_FILE });
    const { store, inserts } = recordingStore();

    const result = await collectReferenceFx(PAIRS, "public", store, { fetch: fetchImpl });

    const zar = result.samples.find((s) => s.buyAsset === "iso4217:ZAR")!;
    expect(zar.rate).toBe("18.43");
    expect(ecbOf(zar)).toMatchObject({
      status: "differs",
      crossRate: "17.55316628",
      deviationBps: 499,
    });
    expect(inserts).toHaveLength(5);
  });

  it("reports a pair the source has no rate for instead of guessing one", async () => {
    const { fetchImpl } = stubFetch({ [JSDELIVR]: USD_FILE, [ECB_DAILY_URL]: ECB_FILE });
    const pairs = [...PAIRS, { base: "USD", quote: "QQQ" }];
    const result = await collectReferenceFx(pairs, "public", undefined, { fetch: fetchImpl });
    expect(result.missing).toEqual([{ base: "USD", quote: "QQQ" }]);
    expect(result.samples).toHaveLength(5);
  });

  it("skips the ECB when asked to, and makes no request for no pairs", async () => {
    const off = stubFetch({ [JSDELIVR]: USD_FILE });
    const result = await collectReferenceFx(PAIRS, "public", undefined, {
      fetch: off.fetchImpl,
      ecbCheck: false,
    });
    expect(off.urls).toEqual([JSDELIVR]);
    expect(result.samples[0]!.detail).not.toHaveProperty("ecb");

    const none = stubFetch({});
    expect(
      await collectReferenceFx([], "public", undefined, { fetch: none.fetchImpl }),
    ).toEqual({
      samples: [],
      inserted: 0,
      missing: [],
    });
    expect(none.urls).toEqual([]);
  });

  it("refuses an unknown network or a malformed pair before any request", async () => {
    const { fetchImpl, urls } = stubFetch({});
    await expect(
      collectReferenceFx(PAIRS, "mainnet" as never, undefined, { fetch: fetchImpl }),
    ).rejects.toThrow(RangeError);
    await expect(
      collectReferenceFx([{ base: "USD", quote: "usd" }], "public", undefined, {
        fetch: fetchImpl,
      }),
    ).rejects.toThrow(RangeError);
    expect(urls).toEqual([]);
  });
});

describe("the pairs config", () => {
  it("ships the five corridor currencies against the dollar", () => {
    expect(
      loadReferenceFxPairsConfig(resolve(process.cwd(), "config/reference-fx-pairs.json")),
    ).toEqual(PAIRS);
  });

  it.each([
    [{}, /must be a JSON array/],
    [[null], /pair 0 must be an object/],
    [[{ base: "USD" }], /pair 0: quote must be an ISO 4217 code/],
    [[{ base: "usd", quote: "NGN" }], /pair 0: base must be an ISO 4217 code/],
    [[{ base: "USD", quote: "USD" }], /same currency/],
    [
      [
        { base: "USD", quote: "NGN" },
        { base: "USD", quote: "NGN" },
      ],
      /pair 1: USD\/NGN is listed twice/,
    ],
  ])("refuses %j", (raw, message) => {
    expect(() => parseReferenceFxPairsConfig(raw)).toThrow(message);
  });
});
