// What an anchor card may claim, given what the probe actually managed to read.
//
// An empty `seps` list means two very different things: the probe read the
// anchor's stellar.toml and it advertises nothing, or the probe never read the
// toml at all (many anchor domains answer automated requests with HTTP 403 or
// time out from CI runners). Only the first is a fact about the anchor. These
// helpers keep the card from wording the second as if it were the first.
//
// Pure and self-contained on purpose (no imports from the rest of web/,
// structural types only) so the wording is unit-tested from the repo's root
// test suite.

/** Whether the probe got the anchor's stellar.toml. */
export type TomlStatus = "read" | "unreachable" | "not-probed";

/** The parts of an attestation these helpers read; `AnchorAttestation` satisfies it. */
export interface AnchorLike {
  domain: string;
  seps: number[];
  probesRun: readonly string[];
  probesPassed: readonly string[];
  tomlHash: string;
  servesSep31: boolean;
}

/** Shown in place of a toml hash that does not describe a real document. */
export const NO_TOML_HASH = "—";

export function tomlStatus(anchor: AnchorLike): TomlStatus {
  if (!anchor.probesRun.includes("toml_fetch")) return "not-probed";
  return anchor.probesPassed.includes("toml_fetch") ? "read" : "unreachable";
}

/**
 * The line under the domain. "no SEP endpoints" is only said when the toml was
 * read and advertises none; otherwise the line says why there is nothing to list.
 */
export function sepSummary(anchor: AnchorLike): string {
  switch (tomlStatus(anchor)) {
    case "unreachable":
      return "stellar.toml unreachable from the probe";
    case "not-probed":
      return "stellar.toml not probed";
    case "read":
      return anchor.seps.length
        ? anchor.seps.map((n) => `SEP-${n}`).join(" · ")
        : "no SEP endpoints";
  }
}

/**
 * Whether the card may give a SEP-31 verdict at all. Without the toml the probe
 * cannot know what the anchor serves, so a "no SEP-31" badge would be a claim
 * it has no evidence for.
 */
export function canJudgeSep31(anchor: AnchorLike): boolean {
  return anchor.servesSep31 || tomlStatus(anchor) === "read";
}

/** True for a hash of only zeros: the registry's placeholder when nothing was hashed. */
export function isZeroHash(hash: string): boolean {
  return /^0+$/.test(hash);
}

/**
 * The toml hash to display, or undefined when there is no real one: the toml
 * was never fetched, or the registry holds the all-zero placeholder.
 */
export function displayTomlHash(anchor: AnchorLike): string | undefined {
  if (tomlStatus(anchor) !== "read") return undefined;
  if (!anchor.tomlHash || isZeroHash(anchor.tomlHash)) return undefined;
  return anchor.tomlHash;
}

/**
 * Anchors whose toml was read come first, so the cards with real results lead.
 * Within each group the incoming order is kept (the registry sorts by domain).
 */
export function sortAnchorsForDisplay<A extends AnchorLike>(anchors: readonly A[]): A[] {
  const rank = (a: A) => (tomlStatus(a) === "read" ? 0 : 1);
  return anchors
    .map((a, i) => ({ a, i }))
    .sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i)
    .map(({ a }) => a);
}
