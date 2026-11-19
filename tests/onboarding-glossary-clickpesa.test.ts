import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { docs } from "../web/lib/docs";

describe("Onboarding, Glossary, Router Docs, and ClickPesa Probe (#642, #652, #705, #706)", () => {
  const root = process.cwd();

  describe("ClickPesa (connect.clickpesa.com) probe investigation (#652)", () => {
    it("records dated findings in contracts/anchors.json comment", () => {
      const anchorsJsonPath = resolve(root, "contracts/anchors.json");
      const anchorsData = JSON.parse(readFileSync(anchorsJsonPath, "utf8"));
      const comments = (anchorsData.$comment as string[]).join("\n");

      expect(comments).toContain("connect.clickpesa.com");
      expect(comments).toContain("2026-11-19");
      expect(comments).toContain("ENOTFOUND");
    });
  });

  describe("Onboarding guide for sending businesses (#642)", () => {
    const onboardingPath = resolve(root, "docs/onboarding.md");

    it("creates docs/onboarding.md with required operational and legal sections", () => {
      expect(existsSync(onboardingPath)).toBe(true);
      const content = readFileSync(onboardingPath, "utf8");

      expect(content).toContain("What a Receiver Checks");
      expect(content).toContain("Company Profile");
      expect(content).toContain("SEP-12");
      expect(content).toContain("Exporters and Technical Integration");
      expect(content).toContain("Lane Checks");
      expect(content).toContain("Legal Responsibility");
    });

    it("is linked from README.md", () => {
      const readme = readFileSync(resolve(root, "README.md"), "utf8");
      expect(readme).toContain("docs/onboarding.md");
    });
  });

  describe("Smart router and price labels in plain words (#705)", () => {
    it("explains the smart router and the three price labels in README.md", () => {
      const readme = readFileSync(resolve(root, "README.md"), "utf8");
      expect(readme).toContain("Routing and Price Labels");
      expect(readme).toContain("`locked`");
      expect(readme).toContain("`indicative`");
      expect(readme).toContain("`estimated`");
      expect(readme).toContain("docs/route-resolver.md");
    });
  });

  describe("Glossary for non-engineers (#706)", () => {
    const glossaryPath = resolve(root, "docs/glossary.md");

    it("creates docs/glossary.md with one-sentence definitions of key terms", () => {
      expect(existsSync(glossaryPath)).toBe(true);
      const content = readFileSync(glossaryPath, "utf8");

      expect(content).toContain("**Anchor**");
      expect(content).toContain("**Corridor");
      expect(content).toContain("**SEP-31**");
      expect(content).toContain("**Locked Price**");
      expect(content).toContain("**Indicative Price**");
      expect(content).toContain("**Estimated Price**");
      expect(content).toContain("**Settle Leg**");
      expect(content).toContain("**Reconciliation**");
      expect(content).toContain("**Idempotency**");
    });

    it("is linked from README.md", () => {
      const readme = readFileSync(resolve(root, "README.md"), "utf8");
      expect(readme).toContain("docs/glossary.md");
    });

    it("is included in the web docs registry", () => {
      const slugs = docs.map((d) => d.slug);
      expect(slugs).toContain("glossary");
      expect(slugs).toContain("onboarding");
    });
  });
});
