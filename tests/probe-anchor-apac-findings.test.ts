import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { probeAnchor } from "@corridor/probe";

describe("Anchor Probe Investigations — Arf, OwlPay, Lightnet, Mercuryo (#658, #657, #656, #655)", () => {
  const root = process.cwd();
  const anchorsJsonPath = resolve(root, "contracts/anchors.json");
  const anchorsData = JSON.parse(readFileSync(anchorsJsonPath, "utf8"));
  const comments = (anchorsData.$comment as string[]).join("\n");

  describe("Arf (arf.one) probe investigation (#658)", () => {
    it("documents why arf.one fails toml_fetch with dated HTTP 404 findings", () => {
      expect(comments).toContain("arf.one");
      expect(comments).toContain("2026-11-19");
      expect(comments).toContain("HTTP 404");
      expect(comments).toContain("hosts no active stellar.toml");
    });
  });

  describe("OwlPay (owlting.com) probe investigation (#657)", () => {
    it("documents why owlting.com fails toml_fetch with dated HTTP 404 findings", () => {
      expect(comments).toContain("owlting.com");
      expect(comments).toContain("2026-11-19");
      expect(comments).toContain("HTTP 404");
      expect(comments).toContain("hosts no active stellar.toml");
    });
  });

  describe("Lightnet (lightnet.io) probe investigation (#656)", () => {
    it("documents why lightnet.io fails toml_fetch with dated HTTP 404 findings", () => {
      expect(comments).toContain("lightnet.io");
      expect(comments).toContain("2026-11-19");
      expect(comments).toContain("HTTP 404");
      expect(comments).toContain("hosts no active stellar.toml");
    });
  });

  describe("Mercuryo (mercuryo.io) probe investigation (#655)", () => {
    it("documents why mercuryo.io fails toml_fetch with dated HTTP 404 findings", () => {
      expect(comments).toContain("mercuryo.io");
      expect(comments).toContain("2026-11-19");
      expect(comments).toContain("HTTP 404");
      expect(comments).toContain("hosts no active stellar.toml");
    });
  });

  describe("Probe behavior when stellar.toml returns HTTP 404", () => {
    it("fails at toml_fetch and discovers no SEPs", async () => {
      const mockFetch: typeof fetch = async (_input, _init) => {
        return new Response("Not Found", { status: 404, statusText: "Not Found" });
      };

      for (const domain of ["arf.one", "owlting.com", "lightnet.io", "mercuryo.io"]) {
        const result = await probeAnchor(domain, { fetchImpl: mockFetch });
        expect(result.seps).toBe(0);
        const tomlOutcome = result.outcomes.find((o) => o.probe === "toml_fetch");
        expect(tomlOutcome).toBeDefined();
        expect(tomlOutcome?.passed).toBe(false);
        expect(tomlOutcome?.detail).toBe("HTTP 404");
      }
    });
  });
});
