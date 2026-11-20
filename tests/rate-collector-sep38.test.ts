import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  collectSep38Rates,
  collectSep38RatesForAnchor,
  findSep38AttestedAnchors,
  getSep38AttestedDomains,
  createSep38CollectorStep,
  parsePricesResponse,
  DEFAULT_SEP38_REFERENCE_AMOUNT,
  type Sep38RateSample,
  type Logger,
  type RegistryLike,
} from "@corridor/engine";

describe("SEP-38 Rate Collector (#590)", () => {
  let logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }>;
  let testLogger: Logger;

  beforeEach(() => {
    logs = [];
    testLogger = {
      log: (level, msg, fields) => {
        logs.push({ level, msg, fields });
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("parsePricesResponse", () => {
    it("parses { prices: [{ sell_asset, buy_asset }] }", () => {
      const data = {
        prices: [
          {
            sell_asset:
              "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            buy_asset: "iso4217:USD",
          },
          {
            sell_asset:
              "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            buy_asset: "iso4217:NGN",
          },
        ],
      };
      const pairs = parsePricesResponse(data);
      expect(pairs).toHaveLength(2);
      expect(pairs[0]?.buyAsset).toBe("iso4217:USD");
      expect(pairs[1]?.buyAsset).toBe("iso4217:NGN");
    });

    it("parses { buy_assets: [{ asset }] } relative to fallbackSellAsset", () => {
      const data = {
        buy_assets: [{ asset: "iso4217:EUR" }, { asset: "iso4217:BRL" }],
      };
      const pairs = parsePricesResponse(data, "stellar:USDC");
      expect(pairs).toEqual([
        { sellAsset: "stellar:USDC", buyAsset: "iso4217:EUR" },
        { sellAsset: "stellar:USDC", buyAsset: "iso4217:BRL" },
      ]);
    });

    it("parses { sell_assets: [{ asset }] } relative to fallbackSellAsset", () => {
      const data = {
        sell_assets: [{ asset: "stellar:XLM" }],
      };
      const pairs = parsePricesResponse(data, "iso4217:USD");
      expect(pairs).toEqual([{ sellAsset: "stellar:XLM", buyAsset: "iso4217:USD" }]);
    });

    it("returns empty array for empty or invalid data", () => {
      expect(parsePricesResponse(null)).toEqual([]);
      expect(parsePricesResponse(undefined)).toEqual([]);
      expect(parsePricesResponse({})).toEqual([]);
      expect(parsePricesResponse("invalid string")).toEqual([]);
    });

    it("deduplicates identical pairs", () => {
      const data = {
        prices: [
          { sell_asset: "stellar:USDC", buy_asset: "iso4217:USD" },
          { sell_asset: "stellar:USDC", buy_asset: "iso4217:USD" },
        ],
      };
      const pairs = parsePricesResponse(data);
      expect(pairs).toHaveLength(1);
    });
  });

  describe("Registry filtering", () => {
    it("finds anchor domains where sep38_quote probe passed", () => {
      const attestations = [
        { domain: "anchor-a.com", probesPassed: ["toml_fetch", "sep38_quote"] },
        { domain: "anchor-b.com", probesPassed: ["toml_fetch", "sep31_info"] },
        { domain: "anchor-c.com", probesPassed: ["sep38_quote", "sep10_auth"] },
      ];
      const passing = findSep38AttestedAnchors(attestations);
      expect(passing).toEqual(["anchor-a.com", "anchor-c.com"]);
    });

    it("getSep38AttestedDomains scans registry instance", async () => {
      const mockRegistry: RegistryLike = {
        domains: async () => ["anchor1.org", "anchor2.org", "anchor3.org"],
        getAnchor: async (domain: string) => {
          if (domain === "anchor1.org") return { probesPassed: ["sep38_quote"] };
          if (domain === "anchor2.org") return { probesPassed: ["sep31_info"] };
          if (domain === "anchor3.org") throw new Error("not found");
          return { probesPassed: [] };
        },
      };

      const domains = await getSep38AttestedDomains(mockRegistry);
      expect(domains).toEqual(["anchor1.org"]);
    });
  });

  describe("Stubbed SEP-38 Server Scenarios", () => {
    it("success: polls GET /prices then GET /price and records samples with source=sep38_price", async () => {
      const recordedSamples: Sep38RateSample[] = [];
      const fetchCalls: string[] = [];

      const mockFetch: typeof fetch = async (input) => {
        const urlStr = input.toString();
        fetchCalls.push(urlStr);
        const url = new URL(urlStr);

        if (url.pathname === "/sep38/prices") {
          return new Response(
            JSON.stringify({
              buy_assets: [
                { asset: "iso4217:USD", price: "1.0000000" },
                { asset: "iso4217:NGN", price: "1550.5000000" },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        if (url.pathname === "/sep38/price") {
          const buyAsset = url.searchParams.get("buy_asset");
          const sellAmount = url.searchParams.get("sell_amount");
          expect(sellAmount).toBe(DEFAULT_SEP38_REFERENCE_AMOUNT);

          if (buyAsset === "iso4217:USD") {
            return new Response(
              JSON.stringify({
                price: "1.0000000",
                total_price: "1.0005000",
                sell_amount: "100",
                buy_amount: "100.00",
                fee: { total: "0.05", asset: "iso4217:USD" },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }

          if (buyAsset === "iso4217:NGN") {
            return new Response(
              JSON.stringify({
                price: "1550.5000000",
                total_price: "1551.0000000",
                sell_amount: "100",
                buy_amount: "155050.00",
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
        }

        return new Response("Not Found", { status: 404 });
      };

      const result = await collectSep38Rates({
        anchors: ["testanchor.stellar.org"],
        fetch: mockFetch,
        store: (s) => {
          recordedSamples.push(s);
        },
        now: () => 1700000000000,
        logger: testLogger,
      });

      expect(result.anchorsAttempted).toBe(1);
      expect(result.anchorsSucceeded).toBe(1);
      expect(result.anchorsFailed).toBe(0);
      expect(result.samples).toHaveLength(2);
      expect(recordedSamples).toHaveLength(2);

      // Verify sample tagged source=sep38_price with anchorDomain
      const ngnSample = result.samples.find((s) => s.buyAsset === "iso4217:NGN");
      expect(ngnSample).toBeDefined();
      expect(ngnSample?.source).toBe("sep38_price");
      expect(ngnSample?.anchorDomain).toBe("testanchor.stellar.org");
      expect(ngnSample?.rate).toBe("1550.5000000");
      expect(ngnSample?.sampledAt).toBe(1700000000000);
      expect(ngnSample?.network).toBe("public");
      expect(ngnSample?.detail?.totalPrice).toBe("1551.0000000");

      const usdSample = result.samples.find((s) => s.buyAsset === "iso4217:USD");
      expect(usdSample?.rate).toBe("1.0000000");
      expect(usdSample?.anchorDomain).toBe("testanchor.stellar.org");
      expect(usdSample?.source).toBe("sep38_price");
    });

    it("401: handles HTTP 401 Unauthorized with error isolation", async () => {
      const mockFetch: typeof fetch = async (input) => {
        const url = new URL(input.toString());
        if (url.pathname === "/sep38/prices") {
          return new Response(JSON.stringify({ error: "authentication required" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      };

      const result = await collectSep38Rates({
        anchors: ["auth-required.anchor.com"],
        fetch: mockFetch,
        logger: testLogger,
      });

      expect(result.anchorsAttempted).toBe(1);
      expect(result.anchorsSucceeded).toBe(0);
      expect(result.anchorsFailed).toBe(1);
      expect(result.samples).toHaveLength(0);
      expect(result.errorsByDomain["auth-required.anchor.com"]).toContain("401 Unauthorized");

      // Verify warning log
      const errLog = logs.find((l) => l.msg === "corridor.rate_collector.sep38.anchor_failed");
      expect(errLog?.fields?.domain).toBe("auth-required.anchor.com");
    });

    it("timeout: handles request timeout with error isolation", async () => {
      const mockFetch: typeof fetch = async () => {
        // Simulate hanging request that triggers AbortSignal
        return new Promise((_, reject) => {
          setTimeout(() => {
            const err = new Error("The operation was aborted due to timeout");
            err.name = "TimeoutError";
            reject(err);
          }, 50);
        });
      };

      const result = await collectSep38Rates({
        anchors: ["slow-anchor.com"],
        timeoutMs: 20,
        fetch: mockFetch,
        logger: testLogger,
      });

      expect(result.anchorsAttempted).toBe(1);
      expect(result.anchorsSucceeded).toBe(0);
      expect(result.anchorsFailed).toBe(1);
      expect(result.samples).toHaveLength(0);
      expect(result.errorsByDomain["slow-anchor.com"]).toBeDefined();
    });

    it("malformed body: handles invalid JSON from /prices and /price", async () => {
      const mockFetch: typeof fetch = async (input) => {
        const url = new URL(input.toString());
        if (url.pathname === "/sep38/prices") {
          return new Response("<html>502 Bad Gateway</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        return new Response("Not Found", { status: 404 });
      };

      const result = await collectSep38Rates({
        anchors: ["broken-json.com"],
        fetch: mockFetch,
        logger: testLogger,
      });

      expect(result.anchorsAttempted).toBe(1);
      expect(result.anchorsSucceeded).toBe(0);
      expect(result.anchorsFailed).toBe(1);
      expect(result.errorsByDomain["broken-json.com"]).toContain("malformed JSON");
    });

    it("malformed body: handles missing price field in GET /price", async () => {
      const mockFetch: typeof fetch = async (input) => {
        const url = new URL(input.toString());
        if (url.pathname === "/sep38/prices") {
          return new Response(JSON.stringify({ buy_assets: [{ asset: "iso4217:USD" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.pathname === "/sep38/price") {
          return new Response(
            JSON.stringify({ some_other_field: "123" }), // missing price and total_price
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("Not Found", { status: 404 });
      };

      const result = await collectSep38Rates({
        anchors: ["no-price.com"],
        fetch: mockFetch,
        logger: testLogger,
      });

      expect(result.anchorsAttempted).toBe(1);
      expect(result.anchorsSucceeded).toBe(0);
      expect(result.anchorsFailed).toBe(1);
      expect(result.errorsByDomain["no-price.com"]).toContain("invalid or missing price");
    });

    it("handles 401 on GET /price", async () => {
      const mockFetch: typeof fetch = async (input) => {
        const url = new URL(input.toString());
        if (url.pathname === "/sep38/prices") {
          return new Response(JSON.stringify({ buy_assets: [{ asset: "iso4217:USD" }] }), {
            status: 200,
          });
        }
        if (url.pathname === "/sep38/price") {
          return new Response("Unauthorized", { status: 401 });
        }
        return new Response("Not Found", { status: 404 });
      };

      const result = await collectSep38Rates({
        anchors: ["price-401.com"],
        fetch: mockFetch,
        logger: testLogger,
      });

      expect(result.anchorsFailed).toBe(1);
      expect(result.errorsByDomain["price-401.com"]).toContain("401 Unauthorized");
    });

    it("handles 500 error on GET /price", async () => {
      const mockFetch: typeof fetch = async (input) => {
        const url = new URL(input.toString());
        if (url.pathname === "/sep38/prices") {
          return new Response(JSON.stringify({ buy_assets: [{ asset: "iso4217:USD" }] }), {
            status: 200,
          });
        }
        if (url.pathname === "/sep38/price") {
          return new Response("Server error", { status: 500 });
        }
        return new Response("Not Found", { status: 404 });
      };

      const result = await collectSep38Rates({
        anchors: ["price-500.com"],
        fetch: mockFetch,
        logger: testLogger,
      });

      expect(result.anchorsFailed).toBe(1);
      expect(result.errorsByDomain["price-500.com"]).toContain("HTTP 500");
    });

    it("handles malformed JSON on GET /price", async () => {
      const mockFetch: typeof fetch = async (input) => {
        const url = new URL(input.toString());
        if (url.pathname === "/sep38/prices") {
          return new Response(JSON.stringify({ buy_assets: [{ asset: "iso4217:USD" }] }), {
            status: 200,
          });
        }
        if (url.pathname === "/sep38/price") {
          return new Response("{not-valid-json", { status: 200 });
        }
        return new Response("Not Found", { status: 404 });
      };

      const result = await collectSep38Rates({
        anchors: ["price-bad-json.com"],
        fetch: mockFetch,
        logger: testLogger,
      });

      expect(result.anchorsFailed).toBe(1);
      expect(result.errorsByDomain["price-bad-json.com"]).toContain("malformed JSON");
    });

    it("uses total_price when price field is absent", async () => {
      const mockFetch: typeof fetch = async (input) => {
        const url = new URL(input.toString());
        if (url.pathname === "/sep38/prices") {
          return new Response(JSON.stringify({ buy_assets: [{ asset: "iso4217:USD" }] }), {
            status: 200,
          });
        }
        if (url.pathname === "/sep38/price") {
          return new Response(
            JSON.stringify({ total_price: "1.0020000", sell_amount: "100" }),
            { status: 200 },
          );
        }
        return new Response("Not Found", { status: 404 });
      };

      const result = await collectSep38Rates({
        anchors: ["total-price.com"],
        fetch: mockFetch,
      });

      expect(result.anchorsSucceeded).toBe(1);
      expect(result.samples[0]?.rate).toBe("1.0020000");
    });

    it("resolves targets from attestations and registry options", async () => {
      const mockFetch: typeof fetch = async () =>
        new Response(JSON.stringify({ prices: [] }), { status: 200 });

      // via attestations
      const resAtt = await collectSep38Rates({
        attestations: [
          { domain: "att-a.com", probesPassed: ["sep38_quote"] },
          { domain: "att-b.com", probesPassed: [] },
        ],
        fetch: mockFetch,
      });
      expect(resAtt.anchorsAttempted).toBe(1);

      // via registry
      const resReg = await collectSep38Rates({
        registry: {
          domains: async () => ["reg-a.com"],
          getAnchor: async () => ({ probesPassed: ["sep38_quote"] }),
        },
        fetch: mockFetch,
      });
      expect(resReg.anchorsAttempted).toBe(1);

      // via empty options
      const resEmpty = await collectSep38Rates({ fetch: mockFetch });
      expect(resEmpty.anchorsAttempted).toBe(0);
    });

    it("supports custom resolveQuoteServer and custom sellAssets per target", async () => {
      const queriedUrls: string[] = [];
      const mockFetch: typeof fetch = async (input) => {
        queriedUrls.push(input.toString());
        return new Response(JSON.stringify({ prices: [] }), { status: 200 });
      };

      await collectSep38Rates({
        anchors: [
          {
            domain: "custom-target.org",
            quoteServerUrl: "https://custom.api.org/quotes",
            sellAssets: ["stellar:USDC", "stellar:XLM"],
          },
        ],
        fetch: mockFetch,
      });

      expect(
        queriedUrls.some((u) =>
          u.startsWith("https://custom.api.org/quotes/prices?sell_asset=stellar%3AUSDC"),
        ),
      ).toBe(true);
      expect(
        queriedUrls.some((u) =>
          u.startsWith("https://custom.api.org/quotes/prices?sell_asset=stellar%3AXLM"),
        ),
      ).toBe(true);
    });

    it("multi-anchor error isolation: one anchor failure does not stop others", async () => {
      const recorded: Sep38RateSample[] = [];

      const mockFetch: typeof fetch = async (input) => {
        const url = new URL(input.toString());

        if (url.host === "good1.org") {
          if (url.pathname === "/sep38/prices") {
            return new Response(JSON.stringify({ buy_assets: [{ asset: "iso4217:EUR" }] }), {
              status: 200,
            });
          }
          if (url.pathname === "/sep38/price") {
            return new Response(JSON.stringify({ price: "0.9200000" }), { status: 200 });
          }
        }

        if (url.host === "auth-fail.org") {
          return new Response(JSON.stringify({ error: "401" }), { status: 401 });
        }

        if (url.host === "html-fail.org") {
          return new Response("<not-json>", { status: 200 });
        }

        if (url.host === "good2.org") {
          if (url.pathname === "/sep38/prices") {
            return new Response(JSON.stringify({ buy_assets: [{ asset: "iso4217:GBP" }] }), {
              status: 200,
            });
          }
          if (url.pathname === "/sep38/price") {
            return new Response(JSON.stringify({ price: "0.7800000" }), { status: 200 });
          }
        }

        return new Response("Not Found", { status: 404 });
      };

      const result = await collectSep38Rates({
        anchors: ["good1.org", "auth-fail.org", "html-fail.org", "good2.org"],
        fetch: mockFetch,
        store: {
          record: async (s) => {
            recorded.push(s);
          },
        },
        logger: testLogger,
      });

      expect(result.anchorsAttempted).toBe(4);
      expect(result.anchorsSucceeded).toBe(2);
      expect(result.anchorsFailed).toBe(2);
      expect(result.samples).toHaveLength(2);
      expect(recorded).toHaveLength(2);

      expect(result.samples.map((s) => s.anchorDomain)).toEqual(["good1.org", "good2.org"]);
      expect(result.errorsByDomain["auth-fail.org"]).toBeDefined();
      expect(result.errorsByDomain["html-fail.org"]).toBeDefined();
    });
  });

  describe("CollectorStep helper", () => {
    it("createSep38CollectorStep returns a runnable CollectorStep", async () => {
      const mockFetch: typeof fetch = async (input) => {
        const url = new URL(input.toString());
        if (url.pathname === "/sep38/prices") {
          return new Response(JSON.stringify({ buy_assets: [{ asset: "iso4217:BRL" }] }), {
            status: 200,
          });
        }
        if (url.pathname === "/sep38/price") {
          return new Response(JSON.stringify({ price: "5.5000000" }), { status: 200 });
        }
        return new Response("Not Found", { status: 404 });
      };

      const step = createSep38CollectorStep({
        anchors: ["step-anchor.org"],
        fetch: mockFetch,
      });

      expect(step.name).toBe("sep38_prices");
      const res = await step.run();
      expect(res).toEqual({
        collected: 1,
        anchorsAttempted: 1,
        anchorsSucceeded: 1,
        anchorsFailed: 0,
      });
    });

    it("collectSep38RatesForAnchor throws on direct error", async () => {
      const mockFetch: typeof fetch = async () =>
        new Response("Internal Server Error", { status: 500 });

      await expect(
        collectSep38RatesForAnchor({ domain: "failing.org" }, { fetch: mockFetch }),
      ).rejects.toThrow("GET /prices returned HTTP 500");
    });
  });
});
