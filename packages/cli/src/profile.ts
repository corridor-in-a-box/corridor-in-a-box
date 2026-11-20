// Sending-business company profile validator + `corridor profile validate <file>` (#638).
// Mirrors the v0 JSON schema (version: "0") so businesses can verify completeness before export.

import { readFileSync } from "node:fs";
import { z } from "zod";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const STELLAR_PUB_RE = /^G[A-Z2-7]{55}$/;

function isRealCalendarDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
  );
}

const isoDate = z
  .string()
  .refine(isRealCalendarDate, "expected a valid ISO calendar date (YYYY-MM-DD)");
const countryCode = z
  .string()
  .regex(COUNTRY_RE, "expected an ISO 3166-1 alpha-2 country code");

const PostalAddressSchema = z
  .object({
    line1: z.string().min(1),
    line2: z.string().min(1).optional(),
    city: z.string().min(1),
    region: z.string().min(1).optional(),
    postalCode: z.string().min(1).optional(),
    country: countryCode,
  })
  .strict();

const DocumentRefSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    category: z.enum([
      "incorporation",
      "licence",
      "ownership",
      "identity",
      "aml_policy",
      "address_proof",
      "financials",
      "other",
    ]),
    path: z
      .string()
      .min(1)
      .refine(
        (v) => !v.startsWith("data:"),
        "embedded data URIs are forbidden; reference a file path",
      ),
    sha256: z.string().regex(SHA256_HEX_RE, "expected a 64-character lowercase hex SHA-256"),
    date: isoDate,
  })
  .strict();

export const CompanyProfileV0Schema = z
  .object({
    version: z.literal("0"),
    legalEntity: z
      .object({
        legalName: z.string().min(1),
        tradingName: z.string().min(1).optional(),
        entityType: z.string().min(1),
        countryOfIncorporation: countryCode,
        incorporatedAt: isoDate,
        registeredAddress: PostalAddressSchema,
        operatingAddress: PostalAddressSchema.optional(),
        website: z.string().url().optional(),
      })
      .strict(),
    registrationNumbers: z
      .array(
        z
          .object({
            country: countryCode,
            authority: z.string().min(1),
            number: z.string().min(1),
            issuedAt: isoDate.optional(),
            documentRefId: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1),
    licences: z.array(
      z
        .object({
          jurisdiction: countryCode,
          licenceType: z.string().min(1),
          licenceNumber: z.string().min(1),
          regulator: z.string().min(1),
          status: z.enum(["active", "pending", "exempt", "expired", "revoked"]),
          validUntil: isoDate.optional(),
          documentRefId: z.string().min(1).optional(),
        })
        .strict(),
    ),
    ownership: z
      .object({
        beneficialOwners: z
          .array(
            z
              .object({
                fullName: z.string().min(1),
                ownershipPercent: z.number().min(0).max(100),
                nationality: countryCode,
                countryOfResidence: countryCode,
                isPep: z.boolean().optional(),
                role: z.string().min(1).optional(),
                documentRefId: z.string().min(1).optional(),
              })
              .strict(),
          )
          .min(1),
        directors: z
          .array(
            z
              .object({
                fullName: z.string().min(1),
                role: z.string().min(1),
                nationality: countryCode,
                countryOfResidence: countryCode,
                appointedAt: isoDate.optional(),
                documentRefId: z.string().min(1).optional(),
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),
    amlCft: z
      .object({
        policyVersion: z.string().min(1),
        policyDate: isoDate,
        complianceOfficer: z
          .object({
            name: z.string().min(1),
            title: z.string().min(1),
            email: z.string().email(),
            phone: z.string().min(1).optional(),
          })
          .strict(),
        screeningProviders: z.array(z.string().min(1)).optional(),
        sanctionsRegimes: z.array(z.string().min(1)).min(1),
        transactionMonitoringSummary: z.string().min(1),
        documentRefId: z.string().min(1).optional(),
      })
      .strict(),
    stellarAccounts: z
      .array(
        z
          .object({
            network: z.enum(["public", "testnet"]),
            publicKey: z
              .string()
              .regex(STELLAR_PUB_RE, "expected a valid Stellar G... public key"),
            purpose: z.enum(["settlement", "sep10_auth", "treasury", "distribution", "fee"]),
            label: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1),
    contacts: z
      .array(
        z
          .object({
            role: z.enum(["primary", "compliance", "technical", "finance", "legal"]),
            name: z.string().min(1),
            email: z.string().email(),
            phone: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1),
    documentReferences: z.array(DocumentRefSchema).min(1),
  })
  .strict();

export type CompanyProfile = z.infer<typeof CompanyProfileV0Schema>;

export interface ProfileValidationIssue {
  readonly path: string;
  readonly kind: "missing" | "invalid_type" | "invalid_value" | "io";
  readonly message: string;
}

export type ProfileValidationResult =
  | { readonly ok: true; readonly profile: CompanyProfile }
  | { readonly ok: false; readonly issues: readonly ProfileValidationIssue[] };

function classifyZodIssue(issue: z.ZodIssue): ProfileValidationIssue["kind"] {
  if (issue.code === "invalid_type") {
    const received = (issue as { received?: unknown }).received;
    const messageSaysUndefined = issue.message.toLowerCase().includes("received undefined");
    return received === "undefined" || messageSaysUndefined ? "missing" : "invalid_type";
  }
  return "invalid_value";
}

export function validateCompanyProfile(raw: unknown): ProfileValidationResult {
  const parsed = CompanyProfileV0Schema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, profile: parsed.data };
  }
  const issues: ProfileValidationIssue[] = parsed.error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "<root>",
    kind: classifyZodIssue(issue),
    message: issue.message,
  }));
  return { ok: false, issues };
}

export function loadAndValidateProfile(filePath: string): ProfileValidationResult {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (err) {
    return {
      ok: false,
      issues: [
        {
          path: filePath,
          kind: "io",
          message: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }
  return validateCompanyProfile(raw);
}

export const PROFILE_USAGE = "usage: corridor profile validate <file.json> [--json]";

export type ProfileArgs =
  | { readonly ok: true; readonly file: string; readonly json: boolean }
  | { readonly ok: false; readonly error: string };

export function parseProfileArgs(args: readonly string[]): ProfileArgs {
  if (args[0] !== "validate") {
    return { ok: false, error: PROFILE_USAGE };
  }
  let file: string | undefined;
  let json = false;
  for (const arg of args.slice(1)) {
    if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("--")) {
      return { ok: false, error: `error: unknown option "${arg}"` };
    } else if (!file) {
      file = arg;
    } else {
      return { ok: false, error: `error: unexpected argument "${arg}"` };
    }
  }
  if (!file) {
    return { ok: false, error: PROFILE_USAGE };
  }
  return { ok: true, file, json };
}

export function formatProfileValidation(
  file: string,
  result: ProfileValidationResult,
): string {
  if (result.ok) {
    return `✓ ${file} is a valid v${result.profile.version} company profile (${result.profile.legalEntity.legalName})`;
  }
  const lines = [`✗ ${file} failed validation (${result.issues.length} issue(s)):`];
  for (const issue of result.issues) {
    lines.push(`  - ${issue.path} [${issue.kind}]: ${issue.message}`);
  }
  return lines.join("\n");
}
