// First onboarding exporter targeting the self-hosted SDF Anchor Platform reference
// server (`scripts/reference-anchor.sh`, SEP server at http://localhost:8080) (#640).
//
// Maps a validated v0 company profile into:
//   1. A SEP-12 `PUT /sep12/customer` payload for `type: "sep31-sender"` ( matching what
//      examples/run-testnet.ts and Anchor Platform's sep31-sender type expect).
//   2. The sender's SEP-10 client / settlement Stellar account metadata.
//   3. Reference-only document hashes (path + sha256 + date — binary files are never uploaded).

import { fail, ok, type Outcome } from "@corridor/types";

export interface CompanyProfileLike {
  readonly version: "0";
  readonly legalEntity: {
    readonly legalName: string;
    readonly tradingName?: string;
    readonly countryOfIncorporation: string;
    readonly registeredAddress: {
      readonly line1: string;
      readonly line2?: string;
      readonly city: string;
      readonly region?: string;
      readonly postalCode?: string;
      readonly country: string;
    };
  };
  readonly registrationNumbers: ReadonlyArray<{
    readonly country: string;
    readonly authority: string;
    readonly number: string;
  }>;
  readonly licences: ReadonlyArray<{
    readonly jurisdiction: string;
    readonly licenceType: string;
    readonly licenceNumber: string;
    readonly status: string;
  }>;
  readonly amlCft: {
    readonly policyVersion: string;
    readonly policyDate: string;
    readonly complianceOfficer: {
      readonly name: string;
      readonly title: string;
      readonly email: string;
      readonly phone?: string;
    };
    readonly sanctionsRegimes: readonly string[];
  };
  readonly stellarAccounts: ReadonlyArray<{
    readonly network: "public" | "testnet";
    readonly publicKey: string;
    readonly purpose: "settlement" | "sep10_auth" | "treasury" | "distribution" | "fee";
    readonly label?: string;
  }>;
  readonly contacts: ReadonlyArray<{
    readonly role: string;
    readonly name: string;
    readonly email: string;
    readonly phone?: string;
  }>;
  readonly documentReferences: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly category: string;
    readonly path: string;
    readonly sha256: string;
    readonly date: string;
  }>;
}

export interface ReferenceAnchorExport {
  readonly target: "reference-anchor";
  readonly network: "public" | "testnet";
  readonly sep12Type: "sep31-sender";
  /** SEP-10 authenticated Stellar public key representing the sending business. */
  readonly stellarAccount: string;
  /** Key-value fields ready to submit to `PUT <sepUrl>/sep12/customer`. */
  readonly sep12Fields: Readonly<Record<string, string>>;
  /** Every matching Stellar account configured for the target network. */
  readonly stellarAccounts: ReadonlyArray<{
    readonly publicKey: string;
    readonly purpose: string;
    readonly label?: string;
  }>;
  /** Hashed document references passed as provenance without embedding files. */
  readonly documentHashes: ReadonlyArray<{
    readonly id: string;
    readonly category: string;
    readonly sha256: string;
    readonly date: string;
  }>;
  /** Suggested env variables aligned with `scripts/reference-anchor.sh`. */
  readonly anchorEnv: Readonly<Record<string, string>>;
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "Compliance", lastName: "Officer" };
  if (parts.length === 1) return { firstName: parts[0]!, lastName: parts[0]! };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(" ") };
}

/**
 * Convert a v0 company profile into a self-hosted reference-anchor sender bundle.
 * Throws a descriptive Error if required sender identity, registration, or Stellar
 * account fields are missing for the requested network.
 */
export function exportProfileForReferenceAnchor(
  profile: CompanyProfileLike,
  opts: { readonly network?: "testnet" | "public"; readonly sepUrl?: string } = {},
): ReferenceAnchorExport {
  if (profile.version !== "0") {
    throw new Error(`unsupported company profile version "${String(profile.version)}"`);
  }
  const network = opts.network ?? "testnet";
  const sepUrl = (opts.sepUrl ?? "http://localhost:8080").replace(/\/+$/, "");

  const networkAccounts = profile.stellarAccounts.filter((a) => a.network === network);
  if (networkAccounts.length === 0) {
    throw new Error(
      `company profile declares no Stellar account for network "${network}" required by reference anchor`,
    );
  }
  const preferredAccount =
    networkAccounts.find((a) => a.purpose === "sep10_auth") ??
    networkAccounts.find((a) => a.purpose === "settlement") ??
    networkAccounts[0]!;

  const contact =
    profile.contacts.find((c) => c.role === "compliance") ??
    profile.contacts.find((c) => c.role === "primary") ??
    profile.contacts[0];
  const officer = profile.amlCft.complianceOfficer;
  const representativeName = contact?.name ?? officer.name;
  const representativeEmail = contact?.email ?? officer.email;
  const representativePhone = contact?.phone ?? officer.phone;
  const { firstName, lastName } = splitName(representativeName);

  const reg = profile.registrationNumbers[0];
  if (!reg) {
    throw new Error("company profile requires at least one registrationNumbers entry");
  }

  const addr = profile.legalEntity.registeredAddress;
  const streetAddress = addr.line2 ? `${addr.line1}, ${addr.line2}` : addr.line1;

  const sep12Fields: Record<string, string> = {
    type: "sep31-sender",
    account: preferredAccount.publicKey,
    first_name: firstName,
    last_name: lastName,
    email_address: representativeEmail,
    ...(representativePhone ? { phone_number: representativePhone } : {}),
    organization_name: profile.legalEntity.legalName,
    organization_registration_number: reg.number,
    organization_registration_authority: reg.authority,
    organization_country_code: profile.legalEntity.countryOfIncorporation,
    address: streetAddress,
    city: addr.city,
    ...(addr.postalCode ? { postal_code: addr.postalCode } : {}),
    country_code: addr.country,
  };

  return {
    target: "reference-anchor",
    network,
    sep12Type: "sep31-sender",
    stellarAccount: preferredAccount.publicKey,
    sep12Fields,
    stellarAccounts: networkAccounts.map(({ publicKey, purpose, label }) => ({
      publicKey,
      purpose,
      ...(label ? { label } : {}),
    })),
    documentHashes: profile.documentReferences.map(({ id, category, sha256, date }) => ({
      id,
      category,
      sha256,
      date,
    })),
    anchorEnv: {
      SEP_URL: sepUrl,
      SENDER_SEP12_TYPE: "sep31-sender",
      SENDER_STELLAR_ACCOUNT: preferredAccount.publicKey,
    },
  };
}

/**
 * Submit an exported sender bundle to the reference anchor's SEP-12 `/sep12/customer`
 * endpoint and return the issued customer id (`SENDER_SEP12_ID`).
 */
export async function applyExportToReferenceAnchor(
  exported: ReferenceAnchorExport,
  opts: {
    readonly sepUrl?: string;
    readonly authToken?: string;
    readonly fetchImpl?: typeof fetch;
  } = {},
): Promise<Outcome<{ readonly customerId: string }>> {
  const sepUrl = (
    opts.sepUrl ??
    exported.anchorEnv.SEP_URL ??
    "http://localhost:8080"
  ).replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${sepUrl}/sep12/customer`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(opts.authToken ? { authorization: `Bearer ${opts.authToken}` } : {}),
      },
      body: JSON.stringify(exported.sep12Fields),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return fail(
        "KYC_REQUIRED",
        `reference-anchor SEP-12 PUT /sep12/customer HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
        { retryable: res.status >= 500 },
      );
    }
    const body = (await res.json()) as { id?: string };
    if (!body.id) {
      return fail("KYC_REQUIRED", "reference-anchor SEP-12 response missing customer id");
    }
    return ok({ customerId: body.id });
  } catch (cause) {
    return fail("ANCHOR_UNAVAILABLE", "reference-anchor SEP-12 request failed", {
      retryable: true,
      cause,
    });
  }
}
