import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyExportToReferenceAnchor,
  exportProfileForReferenceAnchor,
  type CompanyProfileLike,
} from "../packages/cli/src/reference-exporter";

const EXAMPLE_PROFILE_FALLBACK: CompanyProfileLike = {
  version: "0",
  legalEntity: {
    legalName: "Acorn Cross-Border Payments Ltd.",
    tradingName: "Acorn Pay",
    countryOfIncorporation: "GB",
    registeredAddress: {
      line1: "20 Bishopsgate",
      city: "London",
      postalCode: "EC2N 4AG",
      country: "GB",
    },
  },
  registrationNumbers: [
    {
      country: "GB",
      authority: "Companies House",
      number: "14812345",
    },
  ],
  licences: [
    {
      jurisdiction: "GB",
      licenceType: "Authorised Payment Institution",
      licenceNumber: "FCA-901234",
      status: "active",
    },
  ],
  amlCft: {
    policyVersion: "2026.2",
    policyDate: "2026-06-01",
    complianceOfficer: {
      name: "Priya Patel",
      title: "Money Laundering Reporting Officer",
      email: "compliance@acornpay.example",
      phone: "+44 20 7946 0192",
    },
    sanctionsRegimes: ["OFAC", "UK-OFSI", "EU", "UN"],
  },
  stellarAccounts: [
    {
      network: "public",
      publicKey: "GBN4NNCDGJO4XW4KQU3CBIESUJWFVBUZPOKUZHT7W7WRB7CWOA7BXVQF",
      purpose: "settlement",
      label: "Production settlement wallet",
    },
    {
      network: "testnet",
      publicKey: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      purpose: "sep10_auth",
      label: "Testnet SEP-10 client key",
    },
  ],
  contacts: [
    {
      role: "primary",
      name: "Adaeze Okafor",
      email: "ops@acornpay.example",
    },
    {
      role: "compliance",
      name: "Priya Patel",
      email: "compliance@acornpay.example",
    },
  ],
  documentReferences: [
    {
      id: "doc-incorp",
      title: "Certificate of Incorporation",
      category: "incorporation",
      path: "onboarding/docs/certificate-of-incorporation.pdf",
      sha256: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
      date: "2023-04-12",
    },
  ],
};

function loadExampleProfile(): CompanyProfileLike {
  const path = new URL("../schemas/examples/company-profile.v0.json", import.meta.url);
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8")) as CompanyProfileLike;
  }
  return EXAMPLE_PROFILE_FALLBACK;
}

describe("reference-anchor onboarding exporter (#640)", () => {
  it("exports the example company profile into SEP-12 sep31-sender fields and Stellar account config", () => {
    const profile = loadExampleProfile();
    const exported = exportProfileForReferenceAnchor(profile);

    expect(exported.target).toBe("reference-anchor");
    expect(exported.network).toBe("testnet");
    expect(exported.sep12Type).toBe("sep31-sender");
    expect(exported.stellarAccount).toBe(
      "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    );
    expect(exported.sep12Fields).toMatchObject({
      type: "sep31-sender",
      account: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      organization_name: "Acorn Cross-Border Payments Ltd.",
      organization_registration_number: "14812345",
      organization_country_code: "GB",
      first_name: "Priya",
      last_name: "Patel",
      email_address: "compliance@acornpay.example",
      city: "London",
      country_code: "GB",
    });
    expect(exported.documentHashes.length).toBeGreaterThanOrEqual(1);
    expect(exported.anchorEnv.SEP_URL).toBe("http://localhost:8080");
  });

  it("refuses export when no Stellar account matches the requested network", () => {
    const noTestnet: CompanyProfileLike = {
      ...EXAMPLE_PROFILE_FALLBACK,
      stellarAccounts: EXAMPLE_PROFILE_FALLBACK.stellarAccounts.filter(
        (a) => a.network !== "testnet",
      ),
    };
    expect(() => exportProfileForReferenceAnchor(noTestnet)).toThrow(/network "testnet"/);
  });

  it("submits exported sep31-sender fields to the reference anchor SEP-12 endpoint", async () => {
    const exported = exportProfileForReferenceAnchor(loadExampleProfile());
    const calls: Array<{ url: string; method: string; auth?: string; body: unknown }> = [];

    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        auth: headers.authorization,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return new Response(JSON.stringify({ id: "ref-sender-123" }), { status: 200 });
    }) as typeof fetch;

    const applied = await applyExportToReferenceAnchor(exported, {
      authToken: "sep10-jwt-test",
      fetchImpl,
    });
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.value.customerId).toBe("ref-sender-123");
    expect(calls[0]?.url).toBe("http://localhost:8080/sep12/customer");
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.auth).toBe("Bearer sep10-jwt-test");
    expect(calls[0]?.body).toEqual(exported.sep12Fields);
  });
});
