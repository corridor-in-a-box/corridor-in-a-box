import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LaneCheckCache,
  RateSampleCollector,
  computeDailySummary,
  assertNetworkIsolation,
  type LaneCheckResult,
  type RateSample,
} from "@corridor/router";
import {
  checkWalletRecipientTrustline,
  type AccountFacts,
  type AccountInspectorLike,
} from "@corridor/stellar";
import { fail, ok } from "@corridor/types";

describe("Lane Cache, Wallet Trustline, Rate Collector, and Banxa Probe (#633, #648, #659, #702)", () => {
  const root = process.cwd();

  describe("Banxa (stellar-sep-24.banxa.com) probe investigation (#659)", () => {
    it("documents why stellar-sep-24.banxa.com fails toml_fetch with dated HTTP 403 findings", () => {
      const anchorsJsonPath = resolve(root, "contracts/anchors.json");
      const anchorsData = JSON.parse(readFileSync(anchorsJsonPath, "utf8"));
      const comments = (anchorsData.$comment as string[]).join("\n");

      expect(comments).toContain("stellar-sep-24.banxa.com");
      expect(comments).toContain("2026-11-19");
      expect(comments).toContain("HTTP 403");
      expect(comments).toContain("Cloudflare edge");
    });
  });

  describe("Lane check caching with fake clock and daily background re-check (#633)", () => {
    it("caches results for 24 hours and refreshes in the background upon expiry", async () => {
      let currentTime = 1_000_000;
      let checkCallCount = 0;

      const mockChecker = async (domain: string): Promise<LaneCheckResult> => {
        checkCallCount++;
        return {
          runnable: true,
          checkedAt: currentTime,
          protocol: "sep31",
          details: { call: checkCallCount, domain },
        };
      };

      const cache = new LaneCheckCache(mockChecker, {
        ttlMs: 24 * 60 * 60 * 1000,
        clock: () => currentTime,
      });

      // 1. Initial check: calls underlying checker
      const res1 = await cache.check("cowrie.exchange");
      expect(res1.runnable).toBe(true);
      expect(res1.details?.call).toBe(1);
      expect(checkCallCount).toBe(1);

      // 2. Call after 2 hours: within 24h TTL, returns cached without calling checker
      currentTime += 2 * 60 * 60 * 1000;
      const res2 = await cache.check("cowrie.exchange");
      expect(res2.details?.call).toBe(1);
      expect(checkCallCount).toBe(1);

      // 3. Call after 25 hours total: expired (> 24h), returns cached while triggering background refresh
      currentTime += 23 * 60 * 60 * 1000; // now 25h after initial
      expect(cache.isExpired("cowrie.exchange")).toBe(true);

      const res3 = await cache.check("cowrie.exchange");
      // Immediately returns stale result to prevent caller latency spike
      expect(res3.details?.call).toBe(1);

      // Allow background microtasks to complete
      await new Promise((r) => setTimeout(r, 10));

      // Checker was invoked in background
      expect(checkCallCount).toBe(2);
      expect(cache.isExpired("cowrie.exchange")).toBe(false);

      // Subsequent call gets the newly refreshed result
      const res4 = await cache.check("cowrie.exchange");
      expect(res4.details?.call).toBe(2);
    });

    it("handles background refresh failures gracefully without unhandled errors", async () => {
      let currentTime = 1_000_000;
      let shouldFail = false;
      let loggedError: unknown;

      const cache = new LaneCheckCache(
        async () => {
          if (shouldFail) throw new Error("Connection timeout");
          return { runnable: true, checkedAt: currentTime };
        },
        {
          clock: () => currentTime,
          onBackgroundError: (_d, err) => {
            loggedError = err;
          },
        },
      );

      await cache.check("anchor.test");

      // Advance past 24h TTL and trigger failure
      currentTime += 25 * 60 * 60 * 1000;
      shouldFail = true;

      const res = await cache.check("anchor.test");
      expect(res.runnable).toBe(true);

      await new Promise((r) => setTimeout(r, 10));
      expect(loggedError).toBeInstanceOf(Error);
      expect((loggedError as Error).message).toBe("Connection timeout");
    });
  });

  describe("Wallet route trustline check before sending (#648)", () => {
    const mockInspector = (facts?: AccountFacts): AccountInspectorLike => ({
      account: async (address: string) => {
        if (!facts || facts.id !== address) {
          return fail("SETTLEMENT_FAILED", `Account not found: ${address}`);
        }
        return ok(facts);
      },
    });

    it("refuses if recipient account does not exist on-chain", async () => {
      const inspector = mockInspector(undefined);
      const result = await checkWalletRecipientTrustline(
        inspector,
        "GDEMOACCOUNTMISSING1234567890",
        "USDC",
      );

      expect(result.ok).toBe(false);
      expect(result.code).toBe("ACCOUNT_NOT_FOUND");
      expect(result.reason).toContain("not found");
    });

    it("refuses if recipient account returns 404 from loadAccount", async () => {
      const inspector: AccountInspectorLike = {
        loadAccount: async (address: string) => {
          const err = new Error(`Not found: ${address}`);
          (err as unknown as { status: number }).status = 404;
          throw err;
        },
      };
      const result = await checkWalletRecipientTrustline(
        inspector,
        "GDEMOACCOUNTMISSING404",
        "USDC",
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe("ACCOUNT_NOT_FOUND");
      expect(result.reason).toContain("does not exist on-chain");
    });

    it("refuses if recipient account exists but lacks the required trustline", async () => {
      const facts: AccountFacts = {
        id: "GEXISTINGACCOUNTWITHOUTUSDC123",
        subentry_count: 0,
        num_sponsoring: 0,
        num_sponsored: 0,
        balances: [
          {
            asset_type: "native",
            balance: "100.0000000",
            selling_liabilities: "0",
            buying_liabilities: "0",
          },
        ],
      };

      const inspector = mockInspector(facts);
      const result = await checkWalletRecipientTrustline(
        inspector,
        "GEXISTINGACCOUNTWITHOUTUSDC123",
        "USDC",
      );

      expect(result.ok).toBe(false);
      expect(result.code).toBe("TRUSTLINE_MISSING");
      expect(result.reason).toContain("lacks a trustline for USDC");
    });

    it("refuses if trustline exists but is not authorized", async () => {
      const facts: AccountFacts = {
        id: "GAUTHTESTACCOUNT12345",
        subentry_count: 1,
        num_sponsoring: 0,
        num_sponsored: 0,
        balances: [
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
            balance: "50.0000000",
            selling_liabilities: "0",
            buying_liabilities: "0",
            is_authorized: false,
          },
        ],
      };

      const inspector = mockInspector(facts);
      const result = await checkWalletRecipientTrustline(
        inspector,
        "GAUTHTESTACCOUNT12345",
        "USDC",
        { assetIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
      );

      expect(result.ok).toBe(false);
      expect(result.code).toBe("TRUSTLINE_UNAUTHORIZED");
      expect(result.reason).toContain("not authorized");
    });

    it("passes when recipient account has an authorized trustline", async () => {
      const facts: AccountFacts = {
        id: "GVALIDRECIPIENT12345",
        subentry_count: 1,
        num_sponsoring: 0,
        num_sponsored: 0,
        balances: [
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
            balance: "100.0000000",
            selling_liabilities: "0",
            buying_liabilities: "0",
            is_authorized: true,
          },
        ],
      };

      const inspector = mockInspector(facts);
      const result = await checkWalletRecipientTrustline(
        inspector,
        "GVALIDRECIPIENT12345",
        "USDC",
        { assetIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
      );

      expect(result.ok).toBe(true);
      expect(result.reason).toContain("authorized USDC trustline");
    });
  });

  describe("Mainnet rate history collection and network isolation (#702)", () => {
    it("never mixes mainnet and testnet samples in a summary", () => {
      const date = "2026-11-19";
      const timestamp = new Date("2026-11-19T12:00:00Z").getTime();

      const mainnetSamples: RateSample[] = [
        {
          pair: "USDC:iso4217:NGN",
          rate: "1650.0000000",
          source: "sep38_price",
          network: "public",
          sampledAt: timestamp,
          anchorDomain: "cowrie.exchange",
        },
        {
          pair: "USDC:iso4217:NGN",
          rate: "1660.0000000",
          source: "sep38_price",
          network: "public",
          sampledAt: timestamp + 3600_000,
          anchorDomain: "cowrie.exchange",
        },
      ];

      const testnetSamples: RateSample[] = [
        {
          pair: "USDC:iso4217:NGN",
          rate: "1000.0000000", // fictional testnet rate
          source: "sep38_price",
          network: "testnet",
          sampledAt: timestamp,
          anchorDomain: "testanchor.stellar.org",
        },
      ];

      const collector = new RateSampleCollector();
      collector.recordBatch([...mainnetSamples, ...testnetSamples]);

      // 1. Mainnet summary must strictly contain only public network samples
      const publicSummary = computeDailySummary(
        collector.getSamples("public"),
        "public",
        "USDC:iso4217:NGN",
        date,
      );

      expect(publicSummary).toBeDefined();
      expect(publicSummary?.network).toBe("public");
      expect(publicSummary?.count).toBe(2);
      expect(publicSummary?.min).toBe("1650.0000000");
      expect(publicSummary?.max).toBe("1660.0000000");
      expect(publicSummary?.median).toBe("1655.0000000");

      // 2. Testnet summary must strictly contain only testnet samples
      const testnetSummary = computeDailySummary(
        collector.getSamples("testnet"),
        "testnet",
        "USDC:iso4217:NGN",
        date,
      );

      expect(testnetSummary).toBeDefined();
      expect(testnetSummary?.network).toBe("testnet");
      expect(testnetSummary?.count).toBe(1);
      expect(testnetSummary?.min).toBe("1000.0000000");

      // 3. Assert network isolation check throws if mixed samples are provided
      expect(() => {
        assertNetworkIsolation([...mainnetSamples, ...testnetSamples], "public");
      }).toThrow(/Network isolation violation/);
    });
  });
});
