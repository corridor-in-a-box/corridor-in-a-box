import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeSeps, probeAnchor } from "@corridor/probe";

// Probe findings for MyKobo (#650), BlindPay (#651), Coins.ph (#653) and
// Anclap (#654). The records live in contracts/anchors.json; these tests keep
// them from silently disappearing and pin the probe behaviour the MyKobo
// finding depends on.

const anchors = JSON.parse(
  readFileSync(resolve(process.cwd(), "contracts/anchors.json"), "utf8"),
);
const comments = (anchors.$comment as string[]).join("\n");

function paragraphAbout(domain: string): string {
  const para = comments
    .split("\n\n")
    .find((p) => p.startsWith(domain) || p.includes(` ${domain}.`));
  expect(para, `no $comment paragraph for ${domain}`).toBeDefined();
  return para as string;
}

describe("anchor probe findings (#650, #651, #653, #654)", () => {
  it("keeps all four domains in the fleet", () => {
    for (const d of ["mykobo.co", "blindpay.com", "coins.ph", "anclap.com.ar"]) {
      expect(anchors.domains).toContain(d);
    }
  });

  it("records a dated MyKobo finding naming the dead API host", () => {
    const p = paragraphAbout("mykobo.co");
    expect(p).toContain("2026-11-24");
    expect(p).toContain("stellar.mykobo.co");
    expect(p).toContain("NXDOMAIN");
    expect(p).toContain("probe is correct");
  });

  it("records a dated BlindPay finding with the HTTP status", () => {
    const p = comments.split("\n\n").find((x) => x.startsWith("BlindPay appears"));
    expect(p).toBeDefined();
    expect(p).toContain("2026-11-24");
    expect(p).toContain("HTTP 403");
  });

  it("records a dated Coins.ph finding with the HTTP status", () => {
    const p = paragraphAbout("coins.ph");
    expect(p).toContain("2026-11-24");
    expect(p).toContain("HTTP 404");
  });

  it("records a dated Anclap finding with the DNS failure", () => {
    const p = paragraphAbout("anclap.com.ar");
    expect(p).toContain("2026-11-24");
    expect(p).toContain("NXDOMAIN");
  });

  it("reports an unreachable SEP-31 host as a sep31_info failure, not a toml failure", async () => {
    const toml = [
      'VERSION="2.0.0"',
      'NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"',
      'SIGNING_KEY="GAHNDAOJ7IB6KKMGKBGI5JWJHCTFXOVGY4U2N57C2CUZPK3SPEPCLU76"',
      'DIRECT_PAYMENT_SERVER="https://stellar.mykobo.co/sep31"',
    ].join("\n");
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === "https://mykobo.co/.well-known/stellar.toml") {
        return new Response(toml, { status: 200 });
      }
      if (url.startsWith("https://stellar.mykobo.co/")) {
        throw new TypeError("fetch failed", {
          cause: new Error("getaddrinfo ENOTFOUND stellar.mykobo.co"),
        });
      }
      return new Response("not found", { status: 404 });
    };

    const result = await probeAnchor("mykobo.co", { fetchImpl });
    expect(decodeSeps(result.seps)).toContain(31);
    expect(result.outcomes.find((o) => o.probe === "toml_fetch")?.passed).toBe(true);
    const sep31 = result.outcomes.find((o) => o.probe === "sep31_info");
    expect(sep31?.passed).toBe(false);
    expect(sep31?.detail).toBe("fetch failed");
  });
});

describe("anchor probe findings (#660, #661) and the Africa fleet (#664)", () => {
  it("records a dated Flutterwave finding: no stellar.toml, so it cannot receive", () => {
    const p = paragraphAbout("flutterwave.com");
    expect(p).toContain("2026-11-25");
    expect(p).toContain("HTTP 404");
    expect(p).toContain("No corridor manifest is written");
  });

  it("records a dated Bitso finding with the HTTP status the probe actually saw", () => {
    const p = paragraphAbout("bitso.com");
    expect(p).toContain("2026-11-25");
    expect(p).toContain("HTTP 404");
    // The domain resolves; an earlier draft wrongly recorded a DNS failure.
    expect(p).not.toContain("ENOTFOUND");
  });

  const african = [
    ["finclusive.com", "https://anchors.stellar.org/?search=Finclusive"],
    ["chippercash.com", "https://anchors.stellar.org/?search=ChipperCash"],
    ["linkio.africa", "https://anchors.stellar.org/?search=Link"],
    ["impalapay.com", "https://anchors.stellar.org/?search=ImpalaPay"],
    ["yellowcard.io", "https://anchors.stellar.org/?search=Yellow+Card"],
  ] as const;

  it("adds five directory-sourced African anchors, each with a dated finding", () => {
    for (const [domain, source] of african) {
      expect(anchors.domains).toContain(domain);
      const entry = (anchors.anchors as Array<Record<string, unknown>>).find(
        (a) => a.domain === domain,
      );
      expect(entry).toMatchObject({ source, kind: "other", added: "2026-11-25" });
      const para = comments.split("\n\n").find((x) => x.startsWith(`${domain} is `));
      expect(para, `no finding paragraph for ${domain}`).toContain(
        source.replace("https://", ""),
      );
      expect(para).toMatch(/toml_fetch|HTTP 404/);
    }
    expect(comments).toContain("Probed 2026-11-25 with `pnpm probe:anchor <domain>`");
  });

  it("does not add domains that are neither in the directory nor named as anchors", () => {
    for (const d of ["fonbnk.com", "honeycoin.app", "kotanipay.com", "paychant.com"]) {
      expect(anchors.domains).not.toContain(d);
    }
  });
});
