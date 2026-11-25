import { describe, expect, it } from "vitest";
import {
  PostgresRateHistoryStore,
  assertRateSample,
  buyAssetsFromPrices,
  findSep38Anchors,
  pollSep38Prices,
  resolveSep38QuoteServer,
  stellarAssetsFromInfo,
  type Queryable,
  type RateSampleInput,
  type RateSampleRecorder,
  type Sep38AttestationSource,
} from "@corridor/engine";

const USDC = "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const EURC = "stellar:EURC:GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2";

/** A stubbed anchor: its stellar.toml plus SEP-38 handlers under the quote server it names. */
interface StubAnchor {
  toml?: string;
  tomlStatus?: number;
  info?: () => Response;
  prices?: (url: URL) => Response;
  price?: (url: URL) => Response;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * A fetch that serves stubbed anchors by host. Every request is logged; a request to any URL
 * the stubs do not serve is a 404, so a guessed `https://<domain>/sep38` shows up as a failure.
 */
function stubNetwork(
  anchors: Record<string, StubAnchor>,
  quoteServers: Record<string, string>,
) {
  const calls: string[] = [];
  const impl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    if (url.pathname === "/.well-known/stellar.toml") {
      const anchor = anchors[url.host];
      if (!anchor) throw new TypeError(`getaddrinfo ENOTFOUND ${url.host}`);
      if (anchor.tomlStatus) return new Response("", { status: anchor.tomlStatus });
      return new Response(anchor.toml ?? "", { status: 200 });
    }
    for (const [domain, base] of Object.entries(quoteServers)) {
      const anchor = anchors[domain];
      if (!anchor || !url.toString().startsWith(`${base}/`)) continue;
      const path = url.pathname.slice(new URL(base).pathname.replace(/\/$/, "").length);
      if (path === "/info" && anchor.info) return anchor.info();
      if (path === "/prices" && anchor.prices) return anchor.prices(url);
      if (path === "/price" && anchor.price) return anchor.price(url);
    }
    return new Response("not found", { status: 404 });
  };
  return { impl, calls };
}

/** A SEP-38 server that behaves like the spec: required params checked, price = sell per buy. */
function sep38Anchor(opts: {
  quoteServer: string;
  extraToml?: string;
  sellAssets?: string[];
  /** buy asset -> buy_amount for a sell_amount of 100 */
  buyAmounts: Record<string, string>;
}): StubAnchor {
  return {
    toml: [
      `NETWORK_PASSPHRASE = "Public Global Stellar Network ; September 2015"`,
      `DIRECT_PAYMENT_SERVER = "https://example.invalid/sep31"`,
      `ANCHOR_QUOTE_SERVER = "${opts.quoteServer}"`,
      opts.extraToml ?? "",
      `[[CURRENCIES]]`,
      `code = "USDC"`,
    ].join("\n"),
    info: () =>
      json({
        assets: [
          ...(opts.sellAssets ?? [USDC]).map((asset) => ({ asset })),
          { asset: "iso4217:BRL", country_codes: ["BR"] },
        ],
      }),
    prices: (url) => {
      if (!url.searchParams.get("sell_asset") || !url.searchParams.get("sell_amount")) {
        return json({ error: 'The "sell_amount" parameter is missing.' }, 400);
      }
      return json({
        buy_assets: Object.keys(opts.buyAmounts).map((asset) => ({
          asset,
          price: "0.1",
          decimals: 2,
        })),
      });
    },
    price: (url) => {
      const context = url.searchParams.get("context");
      if (context !== "sep31" && context !== "sep6") {
        return json({ error: "Unsupported context. Should be one of [sep6, sep31]." }, 400);
      }
      const buy = url.searchParams.get("buy_asset") ?? "";
      const sellAmount = url.searchParams.get("sell_amount");
      const buyAmount = opts.buyAmounts[buy];
      if (!buyAmount || sellAmount !== "100") return json({ error: "bad request" }, 400);
      return json({
        sell_amount: "100",
        buy_amount: buyAmount,
        fee: { total: "1", asset: USDC },
      });
    },
  };
}

function memoryStore() {
  const samples: RateSampleInput[] = [];
  const store: RateSampleRecorder = {
    async record(sample) {
      assertRateSample(sample); // the real store's validation: SEP-38 assets, domain, decimal rate
      samples.push(sample);
      return true;
    },
  };
  return { store, samples };
}

describe("resolveSep38QuoteServer", () => {
  it("reads ANCHOR_QUOTE_SERVER from stellar.toml instead of guessing a path", async () => {
    const { impl, calls } = stubNetwork(
      {
        "anchor.example": {
          toml: `ANCHOR_QUOTE_SERVER = 'https://quotes.anchor.example/api/v2/'\nDIRECT_PAYMENT_SERVER = "https://anchor.example/sep31"`,
        },
      },
      {},
    );
    const out = await resolveSep38QuoteServer("anchor.example", { fetch: impl });
    expect(out).toEqual({
      quoteServer: "https://quotes.anchor.example/api/v2",
      context: "sep31",
    });
    expect(calls).toEqual(["https://anchor.example/.well-known/stellar.toml"]);
  });

  it("prices in the sep6 context for an anchor with a TRANSFER_SERVER and no SEP-31 server", async () => {
    const { impl } = stubNetwork(
      {
        "anchor.example": {
          toml: `TRANSFER_SERVER = "https://anchor.example/sep6"\nANCHOR_QUOTE_SERVER = "https://anchor.example/sep38"`,
        },
      },
      {},
    );
    const out = await resolveSep38QuoteServer("anchor.example", { fetch: impl });
    expect(out.context).toBe("sep6");
  });

  it("refuses a toml with no quote server, and a quote server on an internal address", async () => {
    const { impl } = stubNetwork(
      {
        "none.example": { toml: `DIRECT_PAYMENT_SERVER = "https://none.example/sep31"` },
        "evil.example": { toml: `ANCHOR_QUOTE_SERVER = "https://169.254.169.254/latest"` },
        "plain.example": { toml: `ANCHOR_QUOTE_SERVER = "http://plain.example/sep38"` },
      },
      {},
    );
    await expect(resolveSep38QuoteServer("none.example", { fetch: impl })).rejects.toThrow(
      /no ANCHOR_QUOTE_SERVER/,
    );
    await expect(resolveSep38QuoteServer("evil.example", { fetch: impl })).rejects.toThrow(
      /not a public https URL/,
    );
    await expect(resolveSep38QuoteServer("plain.example", { fetch: impl })).rejects.toThrow(
      /not a public https URL/,
    );
  });
});

describe("SEP-38 body parsers", () => {
  it("takes only issuer-qualified Stellar assets from GET /info", () => {
    expect(
      stellarAssetsFromInfo({
        assets: [
          { asset: USDC },
          { asset: "stellar:native" },
          { asset: "stellar:USDC" },
          { asset: "iso4217:USD" },
          { asset: USDC },
        ],
      }),
    ).toEqual([USDC, "stellar:native"]);
    expect(() => stellarAssetsFromInfo({ nope: true })).toThrow(/no assets list/);
  });

  it("reads buy_assets from GET /prices and drops ids that are not SEP-38", () => {
    expect(
      buyAssetsFromPrices({
        buy_assets: [{ asset: "iso4217:BRL" }, { asset: "BRL" }, { asset: EURC }, {}],
      }),
    ).toEqual(["iso4217:BRL", EURC]);
    expect(() => buyAssetsFromPrices({ prices: [] })).toThrow(/no buy_assets list/);
    expect(() => buyAssetsFromPrices(null)).toThrow(/no buy_assets list/);
  });
});

describe("pollSep38Prices", () => {
  it("resolves the quote server from stellar.toml, lists pairs with /prices and stores /price rates", async () => {
    const quoteServer = "https://quotes.anchor-a.example/v1";
    const { impl, calls } = stubNetwork(
      {
        "anchor-a.example": sep38Anchor({
          quoteServer,
          buyAmounts: { "iso4217:BRL": "538.42", "iso4217:ARS": "102345.6789" },
        }),
      },
      { "anchor-a.example": quoteServer },
    );
    const { store, samples } = memoryStore();

    const result = await pollSep38Prices({
      network: "public",
      store,
      anchors: ["anchor-a.example"],
      fetch: impl,
      now: () => 1_764_000_000_000,
    });

    expect(result.anchorsFailed).toBe(0);
    expect(result.recorded).toBe(2);
    expect(result.anchors[0]).toMatchObject({
      domain: "anchor-a.example",
      quoteServer,
      status: "ok",
      errors: [],
    });

    // Every SEP-38 call went to the quote server the toml named, never https://<domain>/sep38.
    expect(calls[0]).toBe("https://anchor-a.example/.well-known/stellar.toml");
    expect(calls.slice(1).every((c) => c.startsWith(`${quoteServer}/`))).toBe(true);
    expect(calls.some((c) => c.includes("anchor-a.example/sep38"))).toBe(false);

    // /prices carries the issuer-qualified sell asset and the required sell_amount.
    const prices = new URL(calls.find((c) => c.includes("/prices?"))!);
    expect(prices.searchParams.get("sell_asset")).toBe(USDC);
    expect(prices.searchParams.get("sell_amount")).toBe("100");

    // Rate = buy units per one sell unit = buy_amount / sell_amount, as an exact decimal string.
    expect(samples).toEqual([
      {
        network: "public",
        sellAsset: USDC,
        buyAsset: "iso4217:BRL",
        source: "sep38_price",
        anchorDomain: "anchor-a.example",
        rate: "5.3842",
        sampledAt: 1_764_000_000_000,
        detail: { referenceAmount: "100", buyAmount: "538.42", context: "sep31" },
      },
      expect.objectContaining({ buyAsset: "iso4217:ARS", rate: "1023.456789" }),
    ]);
  });

  it("writes through PostgresRateHistoryStore with the rate as a string parameter", async () => {
    const quoteServer = "https://anchor-a.example/sep38";
    const { impl } = stubNetwork(
      {
        "anchor-a.example": sep38Anchor({
          quoteServer,
          buyAmounts: { "iso4217:BRL": "538.4212345" },
        }),
      },
      { "anchor-a.example": quoteServer },
    );
    const params: unknown[][] = [];
    const db: Queryable = {
      async query<R>(_text: string, p?: unknown[]) {
        params.push(p ?? []);
        return { rows: [{ id: "1" }] as R[] };
      },
    };

    const result = await pollSep38Prices({
      network: "testnet",
      store: new PostgresRateHistoryStore(db),
      anchors: ["anchor-a.example"],
      fetch: impl,
      now: () => 0,
    });

    expect(result.recorded).toBe(1);
    expect(params[0]?.slice(0, 6)).toEqual([
      "testnet",
      USDC,
      "iso4217:BRL",
      "sep38_price",
      "anchor-a.example",
      "5.384212345",
    ]);
  });

  it("counts a sample the store already holds as a duplicate, not a failure", async () => {
    const quoteServer = "https://anchor-a.example/sep38";
    const { impl } = stubNetwork(
      { "anchor-a.example": sep38Anchor({ quoteServer, buyAmounts: { "iso4217:BRL": "5" } }) },
      { "anchor-a.example": quoteServer },
    );
    const result = await pollSep38Prices({
      network: "public",
      store: { record: async () => false },
      anchors: ["anchor-a.example"],
      fetch: impl,
    });
    expect(result).toMatchObject({ recorded: 0, duplicates: 1, anchorsFailed: 0 });
    expect(result.anchors[0]?.pairs[0]?.recorded).toBe(false);
  });

  it("401: an anchor that wants SEP-10 auth fails alone; the others are still stored", async () => {
    const qa = "https://anchor-a.example/sep38";
    const qb = "https://anchor-b.example/quotes";
    const locked = sep38Anchor({ quoteServer: qa, buyAmounts: { "iso4217:BRL": "5" } });
    locked.prices = () => json({ error: "unauthorized" }, 401);
    const { impl } = stubNetwork(
      {
        "anchor-a.example": locked,
        "anchor-b.example": sep38Anchor({
          quoteServer: qb,
          buyAmounts: { "iso4217:MXN": "1712" },
        }),
      },
      { "anchor-a.example": qa, "anchor-b.example": qb },
    );
    const { store, samples } = memoryStore();

    const result = await pollSep38Prices({
      network: "public",
      store,
      anchors: ["anchor-a.example", "anchor-b.example"],
      fetch: impl,
    });

    expect(result.anchorsFailed).toBe(1);
    const [a, b] = result.anchors;
    expect(a?.status).toBe("failed");
    expect(a?.errors.join()).toMatch(/GET \/prices HTTP 401: the anchor requires SEP-10/);
    expect(b?.status).toBe("ok");
    expect(samples.map((s) => [s.anchorDomain, s.rate])).toEqual([
      ["anchor-b.example", "17.12"],
    ]);
  });

  it("401 on /price fails that pair, reported per pair", async () => {
    const q = "https://anchor-a.example/sep38";
    const anchor = sep38Anchor({ quoteServer: q, buyAmounts: { "iso4217:BRL": "5" } });
    anchor.price = () => json({ error: "unauthorized" }, 401);
    const { impl } = stubNetwork({ "anchor-a.example": anchor }, { "anchor-a.example": q });
    const result = await pollSep38Prices({
      network: "public",
      store: memoryStore().store,
      anchors: ["anchor-a.example"],
      fetch: impl,
    });
    expect(result.anchors[0]?.status).toBe("failed");
    expect(result.anchors[0]?.pairs[0]?.error).toMatch(/GET \/price HTTP 401/);
  });

  it("timeout: a hanging anchor is cut off and does not hold up the others", async () => {
    const qb = "https://anchor-b.example/sep38";
    const healthy = stubNetwork(
      {
        "anchor-b.example": sep38Anchor({
          quoteServer: qb,
          buyAmounts: { "iso4217:BRL": "5" },
        }),
      },
      { "anchor-b.example": qb },
    );
    const impl: typeof fetch = (input, init) => {
      if (String(input).startsWith("https://slow.example/")) {
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      }
      return healthy.impl(input, init);
    };
    const { store, samples } = memoryStore();

    const result = await pollSep38Prices({
      network: "public",
      store,
      anchors: ["slow.example", "anchor-b.example"],
      fetch: impl,
      timeoutMs: 50,
    });

    expect(result.anchors[0]?.status).toBe("failed");
    expect(result.anchors[0]?.errors[0]).toMatch(/stellar\.toml could not be read: .*time/i);
    expect(samples).toHaveLength(1);
  });

  it("malformed bodies: non-JSON /prices fails the anchor, a bad /price fails only its pair", async () => {
    const qa = "https://anchor-a.example/sep38";
    const qb = "https://anchor-b.example/sep38";
    const badPrices = sep38Anchor({ quoteServer: qa, buyAmounts: { "iso4217:BRL": "5" } });
    badPrices.prices = () => new Response("<html>oops</html>", { status: 200 });
    const badPair = sep38Anchor({
      quoteServer: qb,
      buyAmounts: { "iso4217:BRL": "5", "iso4217:MXN": "17" },
    });
    const goodPrice = badPair.price!;
    badPair.price = (url) =>
      url.searchParams.get("buy_asset") === "iso4217:BRL"
        ? json({ sell_amount: "100", buy_amount: "lots" })
        : goodPrice(url);
    const { impl } = stubNetwork(
      { "anchor-a.example": badPrices, "anchor-b.example": badPair },
      { "anchor-a.example": qa, "anchor-b.example": qb },
    );
    const { store, samples } = memoryStore();

    const result = await pollSep38Prices({
      network: "public",
      store,
      anchors: ["anchor-a.example", "anchor-b.example"],
      fetch: impl,
    });

    const [a, b] = result.anchors;
    expect(a?.status).toBe("failed");
    expect(a?.errors[0]).toMatch(/GET \/prices returned a body that is not JSON/);
    expect(b?.status).toBe("partial");
    expect(b?.pairs.find((p) => p.buyAsset === "iso4217:BRL")?.error).toMatch(
      /neither buy_amount nor a valid price/,
    );
    expect(samples.map((s) => s.buyAsset)).toEqual(["iso4217:MXN"]);
  });

  it("one sell asset's /prices failing leaves the anchor's other sell assets alone", async () => {
    const q = "https://anchor-a.example/sep38";
    const anchor = sep38Anchor({
      quoteServer: q,
      sellAssets: [USDC, "stellar:native"],
      buyAmounts: { "iso4217:BRL": "20" },
    });
    const prices = anchor.prices!;
    anchor.prices = (url) =>
      url.searchParams.get("sell_asset") === USDC
        ? new Response("", { status: 502 })
        : prices(url);
    const { impl } = stubNetwork({ "anchor-a.example": anchor }, { "anchor-a.example": q });
    const { store, samples } = memoryStore();

    const result = await pollSep38Prices({
      network: "public",
      store,
      anchors: ["anchor-a.example"],
      fetch: impl,
    });

    expect(result.anchors[0]?.status).toBe("partial");
    expect(result.anchors[0]?.errors).toEqual([`${USDC}: GET /prices HTTP 502`]);
    expect(samples.map((s) => [s.sellAsset, s.rate])).toEqual([["stellar:native", "0.2"]]);
  });

  it("does not guess a quote server when the toml names none", async () => {
    const { impl, calls } = stubNetwork(
      {
        "anchor-a.example": {
          toml: `DIRECT_PAYMENT_SERVER = "https://anchor-a.example/sep31"`,
        },
      },
      {},
    );
    const result = await pollSep38Prices({
      network: "public",
      store: memoryStore().store,
      anchors: ["anchor-a.example"],
      fetch: impl,
    });
    expect(result.anchors[0]).toMatchObject({
      status: "failed",
      errors: ["stellar.toml has no ANCHOR_QUOTE_SERVER"],
    });
    expect(calls).toEqual(["https://anchor-a.example/.well-known/stellar.toml"]);
  });

  it("uses caller-named sell assets without /info, and refuses unqualified ones", async () => {
    const q = "https://anchor-a.example/sep38";
    const anchor = sep38Anchor({ quoteServer: q, buyAmounts: { "iso4217:BRL": "5" } });
    anchor.info = () => {
      throw new Error("/info must not be called");
    };
    const { impl } = stubNetwork({ "anchor-a.example": anchor }, { "anchor-a.example": q });
    const result = await pollSep38Prices({
      network: "public",
      store: memoryStore().store,
      anchors: [{ domain: "anchor-a.example", sellAssets: [USDC] }],
      fetch: impl,
    });
    expect(result.recorded).toBe(1);

    await expect(
      pollSep38Prices({
        network: "public",
        store: memoryStore().store,
        sellAssets: ["stellar:USDC"],
        fetch: impl,
      }),
    ).rejects.toThrow(/issuer-qualified/);
    await expect(
      pollSep38Prices({
        network: "public",
        store: memoryStore().store,
        referenceAmount: "-1",
        fetch: impl,
      }),
    ).rejects.toThrow(/referenceAmount/);
  });
});

describe("attested anchors from the registry", () => {
  const registry = (
    records: Record<string, { probesPassed: string[]; staleness: number } | Error>,
  ): Sep38AttestationSource => ({
    domains: async () => Object.keys(records),
    getAnchor: async (domain) => {
      const r = records[domain];
      if (r instanceof Error) throw r;
      return { probesPassed: r!.probesPassed };
    },
    staleness: async (domain) => {
      const r = records[domain];
      if (r instanceof Error) throw r;
      return r!.staleness;
    },
  });

  it("keeps fresh anchors whose sep38_quote probe passed, and says why the rest were skipped", async () => {
    const found = await findSep38Anchors(
      registry({
        "a.example": { probesPassed: ["toml_fetch", "sep38_quote"], staleness: 10 },
        "b.example": { probesPassed: ["toml_fetch", "sep31_info"], staleness: 10 },
        "c.example": { probesPassed: ["sep38_quote"], staleness: 200_000 },
        "d.example": new Error("Error(Contract, #6)"),
      }),
    );
    expect(found.domains).toEqual(["a.example"]);
    expect(found.skipped).toEqual([
      { domain: "b.example", reason: "sep38_quote probe has not passed" },
      {
        domain: "c.example",
        reason: "attestation is 200000 ledgers old, over the 120960 ledger limit",
      },
      { domain: "d.example", reason: "registry lookup failed: Error(Contract, #6)" },
    ]);
  });

  it("polls the registry's attested anchors and records them", async () => {
    const q = "https://a.example/sep38";
    const { impl } = stubNetwork(
      { "a.example": sep38Anchor({ quoteServer: q, buyAmounts: { "iso4217:BRL": "5" } }) },
      { "a.example": q },
    );
    const { store, samples } = memoryStore();
    const result = await pollSep38Prices({
      network: "public",
      store,
      registry: registry({
        "a.example": { probesPassed: ["sep38_quote"], staleness: 1 },
        "b.example": { probesPassed: ["sep31_info"], staleness: 1 },
      }),
      fetch: impl,
    });
    expect(result.anchors.map((a) => a.domain)).toEqual(["a.example"]);
    expect(result.skipped.map((s) => s.domain)).toEqual(["b.example"]);
    expect(samples).toHaveLength(1);
  });

  it("an unreadable registry is reported, and explicitly named anchors are still polled", async () => {
    const q = "https://a.example/sep38";
    const { impl } = stubNetwork(
      { "a.example": sep38Anchor({ quoteServer: q, buyAmounts: { "iso4217:BRL": "5" } }) },
      { "a.example": q },
    );
    const result = await pollSep38Prices({
      network: "public",
      store: memoryStore().store,
      registry: {
        domains: async () => {
          throw new Error("rpc down");
        },
        getAnchor: async () => ({ probesPassed: [] }),
        staleness: async () => 0,
      },
      anchors: ["a.example"],
      fetch: impl,
    });
    expect(result.registryError).toMatch(/rpc down/);
    expect(result.recorded).toBe(1);
  });
});
