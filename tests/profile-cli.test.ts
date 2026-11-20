import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  formatProfileValidation,
  loadAndValidateProfile,
  validateCompanyProfile,
} from "../packages/cli/src/profile";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX_CLI = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../packages/cli/src/index.ts", import.meta.url));

function runCli(args: string[]) {
  return spawnSync(process.execPath, [TSX_CLI, CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

const VALID_PROFILE = {
  version: "0",
  legalEntity: {
    legalName: "Acorn Cross-Border Payments Ltd.",
    entityType: "Private Company Limited by Shares",
    countryOfIncorporation: "GB",
    incorporatedAt: "2023-04-12",
    registeredAddress: {
      line1: "20 Bishopsgate",
      city: "London",
      country: "GB",
    },
  },
  registrationNumbers: [{ country: "GB", authority: "Companies House", number: "14812345" }],
  licences: [
    {
      jurisdiction: "GB",
      licenceType: "Authorised Payment Institution",
      licenceNumber: "FCA-901234",
      regulator: "Financial Conduct Authority",
      status: "active",
    },
  ],
  ownership: {
    beneficialOwners: [
      {
        fullName: "Adaeze Okafor",
        ownershipPercent: 100,
        nationality: "NG",
        countryOfResidence: "GB",
      },
    ],
    directors: [
      {
        fullName: "Adaeze Okafor",
        role: "Managing Director",
        nationality: "NG",
        countryOfResidence: "GB",
      },
    ],
  },
  amlCft: {
    policyVersion: "2026.2",
    policyDate: "2026-06-01",
    complianceOfficer: {
      name: "Priya Patel",
      title: "MLRO",
      email: "compliance@acornpay.example",
    },
    sanctionsRegimes: ["OFAC", "UN"],
    transactionMonitoringSummary: "Pre-transaction sanctions and velocity monitoring.",
  },
  stellarAccounts: [
    {
      network: "testnet",
      publicKey: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      purpose: "settlement",
    },
  ],
  contacts: [{ role: "primary", name: "Adaeze Okafor", email: "ops@acornpay.example" }],
  documentReferences: [
    {
      id: "doc-incorp",
      title: "Certificate of Incorporation",
      category: "incorporation",
      path: "onboarding/docs/certificate.pdf",
      sha256: "a".repeat(64),
      date: "2023-04-12",
    },
  ],
};

describe("company profile validator & CLI (#638)", () => {
  it("validates a complete v0 company profile", () => {
    const res = validateCompanyProfile(VALID_PROFILE);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(formatProfileValidation("profile.json", res)).toContain(
        "Acorn Cross-Border Payments Ltd.",
      );
    }
  });

  it("reports missing required fields clearly", () => {
    const missing = structuredClone(VALID_PROFILE) as Record<string, unknown>;
    delete missing.amlCft;
    const res = validateCompanyProfile(missing);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path === "amlCft" && i.kind === "missing")).toBe(true);
      expect(formatProfileValidation("bad.json", res)).toContain("amlCft [missing]");
    }
  });

  it("reports wrong types on profile fields", () => {
    const wrongType = structuredClone(VALID_PROFILE) as {
      ownership: { beneficialOwners: Array<Record<string, unknown>> };
    };
    wrongType.ownership.beneficialOwners[0]!.ownershipPercent = "100";
    const res = validateCompanyProfile(wrongType);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.issues.some(
          (i) =>
            i.path === "ownership.beneficialOwners.0.ownershipPercent" &&
            i.kind === "invalid_type",
        ),
      ).toBe(true);
    }
  });

  it("rejects non-hex SHA-256 digests and embedded data URIs on documents", () => {
    const badDoc = structuredClone(VALID_PROFILE);
    badDoc.documentReferences[0]!.path = "data:application/pdf;base64,JVBERi0=";
    badDoc.documentReferences[0]!.sha256 = "not-a-hash";
    const res = validateCompanyProfile(badDoc);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.map((i) => i.path)).toContain("documentReferences.0.path");
      expect(res.issues.map((i) => i.path)).toContain("documentReferences.0.sha256");
    }
  });

  it("runs `corridor profile validate <file>` end-to-end for valid and invalid files", () => {
    const dir = mkdtempSync(join(tmpdir(), "corridor-profile-cli-"));
    const goodPath = join(dir, "good.json");
    const badPath = join(dir, "bad.json");
    writeFileSync(goodPath, JSON.stringify(VALID_PROFILE), "utf8");

    const invalid = structuredClone(VALID_PROFILE) as Record<string, unknown>;
    delete invalid.contacts;
    writeFileSync(badPath, JSON.stringify(invalid), "utf8");

    const loaded = loadAndValidateProfile(goodPath);
    expect(loaded.ok).toBe(true);

    const okRun = runCli(["profile", "validate", goodPath]);
    expect(okRun.status).toBe(0);
    expect(okRun.stdout).toContain("valid v0 company profile");

    const badRun = runCli(["profile", "validate", badPath]);
    expect(badRun.status).toBe(1);
    expect(badRun.stderr).toContain("contacts");

    const usageRun = runCli(["profile"]);
    expect(usageRun.status).toBe(2);
    expect(usageRun.stderr).toContain("corridor profile validate");
  });
});
