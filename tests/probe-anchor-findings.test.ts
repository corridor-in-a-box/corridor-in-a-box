import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeSeps, probeAnchor } from "@corridor/probe";

describe("Anchor Probe Investigations (#654, #653, #651, #650)", () => {
  const root = process.cwd();
  const anchorsJsonPath = resolve(root, "contracts/anchors.json");
  const anchorsData = JSON.parse(readFileSync(anchorsJsonPath, "utf8"));
  const comments = (anchorsData.$comment as string[]).join("\n");

  describe("Anclap (anclap.com.ar) probe investigation (#654)", () => {
    it("documents why anclap.com.ar fails toml_fetch with dated DNS ENOTFOUND findings", () => {
      expect(comments).toContain("anclap.com.ar");
      expect(comments).toContain("2026-11-19");
      expect(comments).toContain("ENOTFOUND");
      expect(comments).toContain("no active DNS");
      expect(comments).not.toContain("https://anclap.com.ar/fake");
    });
  });

  describe("Coins.ph (coins.ph) probe investigation (#653)", () => {
    it("documents why coins.ph fails toml_fetch with dated DNS ENOTFOUND findings", () => {
      expect(comments).toContain("coins.ph");
      expect(comments).toContain("2026-11-19");
      expect(comments).toContain("ENOTFOUND");
      expect(comments).toContain("domain does not resolve in DNS");
    });
  });

  describe("BlindPay (blindpay.com) probe investigation (#651)", () => {
    it("documents why blindpay.com fails toml_fetch with dated HTTP 403 findings", () => {
      expect(comments).toContain("blindpay.com");
      expect(comments).toContain("2026-11-19");
      expect(comments).toContain("HTTP 403");
      expect(comments).toContain("Cloudflare");
    });
  });

  describe("MyKobo (mykobo.co) probe investigation (#650)", () => {
    it("documents why mykobo.co advertises SEP-31 but fails sep31_info", () => {
      expect(comments).toContain("mykobo.co");
      expect(comments).toContain("2026-11-19");
      expect(comments).toContain("DIRECT_PAYMENT_SERVER");
      expect(comments).toContain("stellar.mykobo.co");
      expect(comments).toContain("ENOTFOUND");
      expect(comments).toContain("SEP-31 specification");
    });

    it("verifies probe behavior when TOML advertises SEP-31 but endpoint host is unreachable", async () => {
      const mykoboToml = `
VERSION="2.0.0"
NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
SIGNING_KEY="GAHNDAOJ7IB6KKMGKBGI5JWJHCTFXOVGY4U2N57C2CUZPK3SPEPCLU76"
DIRECT_PAYMENT_SERVER="https://stellar.mykobo.co/sep31"
`;
      // Mock fetch: toml_fetch succeeds, but endpoint fetch throws ENOTFOUND
      const mockFetch: typeof fetch = async (input, _init) => {
        const url = String(input);
        if (url.endsWith(".well-known/stellar.toml")) {
          return new Response(mykoboToml, { status: 200 });
        }
        if (url.includes("stellar.mykobo.co")) {
          const err = new TypeError("fetch failed");
          (err as unknown as { cause: Error }).cause = new Error(
            "getaddrinfo ENOTFOUND stellar.mykobo.co",
          );
          throw err;
        }
        return new Response("Not found", { status: 404 });
      };

      const result = await probeAnchor("mykobo.co", { fetchImpl: mockFetch });
      expect(decodeSeps(result.seps)).toContain(31); // Advertises SEP-31

      const sep31Outcome = result.outcomes.find((o) => o.probe === "sep31_info");
      expect(sep31Outcome).toBeDefined();
      expect(sep31Outcome?.passed).toBe(false);
      expect(sep31Outcome?.detail).toBe("fetch failed");
    });
  });
});
