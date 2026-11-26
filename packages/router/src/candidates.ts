// Planner step 1 (RFC 0004): pick the configured corridors whose destination
// matches the requested asset and country. Configuration only — no registry,
// network or pricing here — and every refusal comes back with a reason.
//
// A SEP-6 corridor is only a candidate when its manifest records that the
// receiving anchor accepts third-party payouts (#645, RFC 0004 D5). No
// stellar.toml or SEP-6 /info field says so, so without the flag the corridor is
// never offered for remittance: it is refused here, before any network call,
// rather than discovered after funds have moved.

import { allowsThirdPartyPayout, type Corridor } from "@corridor/manifest";

/** Why a SEP-6 corridor without the manifest flag is not a candidate (#645). */
export const SEP6_THIRD_PARTY_PAYOUT_REASON =
  "SEP-6 corridor without confirmed third-party payout (dest.third_party_payout is not true)";

/** The part of a route request this step needs. A full RouteRequest can be passed:
 *  amount, payout method and policy are for later steps and are ignored here. */
export interface CandidateRequest {
  readonly destAsset: string;
  readonly destCountry: string;
  readonly [key: string]: unknown;
}

export interface NonMatchingCorridor {
  readonly corridor: Corridor;
  readonly reason: string;
}

export interface CandidatesResult {
  /** Matching corridors, in input order. */
  readonly matching: readonly Corridor[];
  /** Every other corridor, in input order, with why it did not match. */
  readonly nonMatching: readonly NonMatchingCorridor[];
}

/** An explicit `dest.country` wins; older manifests declare it as a jurisdiction. */
function destinationCountry(corridor: Corridor): string | undefined {
  return corridor.dest.country ?? corridor.compliance.dest_jurisdiction;
}

/**
 * Split configured corridors into those that can send `destAsset` to
 * `destCountry` and those that cannot. Both comparisons are on declared
 * configuration, so a match is a candidate, not a promise the lane can settle.
 * A SEP-6 corridor also needs `third_party_payout: true` (read through
 * `allowsThirdPartyPayout`); SEP-31, wallet and custom corridors are not gated.
 */
export function candidates(
  request: CandidateRequest,
  corridors: readonly Corridor[],
): CandidatesResult {
  const matching: Corridor[] = [];
  const nonMatching: NonMatchingCorridor[] = [];

  for (const corridor of corridors) {
    const reasons: string[] = [];
    if (corridor.dest.asset !== request.destAsset) {
      reasons.push(`dest.asset "${corridor.dest.asset}" is not "${request.destAsset}"`);
    }

    const country = destinationCountry(corridor);
    if (country?.toUpperCase() !== request.destCountry.toUpperCase()) {
      reasons.push(
        country === undefined
          ? `no destination country (expected "${request.destCountry}")`
          : `dest.country "${country}" is not "${request.destCountry}"`,
      );
    }

    if (corridor.dest.protocol === "sep6" && !allowsThirdPartyPayout(corridor)) {
      reasons.push(SEP6_THIRD_PARTY_PAYOUT_REASON);
    }

    if (reasons.length === 0) matching.push(corridor);
    else nonMatching.push({ corridor, reason: reasons.join("; ") });
  }

  return { matching, nonMatching };
}
