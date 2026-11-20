// @corridor/router — smart router and route selection.
//
// Evaluates candidate corridor manifests for a payment intent (amount, target asset,
// target country), ranks them according to eligibility, verification tier, and live
// availability, and produces structured options with labels and reasons.

import { liveness, protocolOf, type Corridor } from "@corridor/manifest";

export type RouteLabel =
  | "RECOMMENDED"
  | "PROVEN"
  | "VERIFIED"
  | "UNVERIFIED"
  | "NOT_RUNNABLE"
  | "INELIGIBLE"
  | "HALTED";

export interface RouteQuery {
  readonly amount: string;
  readonly to: string;
  readonly country: string;
  readonly offline?: boolean;
}

export interface RankedRoute {
  readonly rank: number;
  readonly corridorId: string;
  readonly destName: string;
  readonly destDomain: string;
  readonly destAsset: string;
  readonly country: string;
  readonly protocol: string;
  readonly label: RouteLabel;
  readonly labels: readonly string[];
  readonly reasons: readonly string[];
  readonly runnable: boolean;
  readonly withinLimits: boolean;
  readonly quoteSource: string;
  readonly estimatedPayout?: string;
  readonly rate?: string;
}

export interface RouteRankOptions {
  readonly fetchImpl?: typeof fetch;
  readonly isBreakerOpen?: (corridorId: string) => boolean | Promise<boolean>;
}

function normalizeAsset(asset: string): string {
  return asset
    .replace(/^iso4217:/i, "")
    .toUpperCase()
    .trim();
}

function isPlaceholderDomain(domain: string): boolean {
  return (
    domain.endsWith(".invalid") ||
    domain.endsWith(".example") ||
    domain.includes(".example.") ||
    domain.startsWith("localhost") ||
    domain.includes("localhost:")
  );
}

/** Check if a corridor matches the target asset and destination country. */
export function matchesRouteTarget(
  corridor: Corridor,
  targetAsset: string,
  targetCountry: string,
): boolean {
  const normTargetAsset = normalizeAsset(targetAsset);
  const normTargetCountry = targetCountry.toUpperCase().trim();

  const corridorDestAsset = normalizeAsset(corridor.dest.asset);
  const corridorPathEnd =
    corridor.fx.path.length > 0
      ? normalizeAsset(corridor.fx.path[corridor.fx.path.length - 1] as string)
      : "";

  const assetMatch =
    corridorDestAsset === normTargetAsset || corridorPathEnd === normTargetAsset;
  if (!assetMatch) return false;

  const corridorCountry = corridor.compliance.dest_jurisdiction.toUpperCase().trim();
  return corridorCountry === normTargetCountry;
}

/**
 * Filter, evaluate, and rank corridor manifests for a given payment target.
 */
export async function rankRoutes(
  query: RouteQuery,
  corridors: readonly Corridor[],
  opts: RouteRankOptions = {},
): Promise<RankedRoute[]> {
  const matching = corridors.filter((c) => matchesRouteTarget(c, query.to, query.country));

  const numAmount = Number(query.amount);

  const evaluated: Array<{
    score: number;
    corridor: Corridor;
    runnable: boolean;
    withinLimits: boolean;
    baseLabel: RouteLabel;
    labels: string[];
    reasons: string[];
    rate?: string;
    estimatedPayout?: string;
  }> = [];

  for (const c of matching) {
    const reasons: string[] = [];
    const labels: string[] = [];
    let withinLimits = true;
    let halted = false;

    if (opts.isBreakerOpen) {
      halted = await Promise.resolve(opts.isBreakerOpen(c.id));
      if (halted) {
        withinLimits = false;
        reasons.push("circuit breaker open (consecutive failures recorded)");
      }
    }

    if (c.limits?.min_amount !== undefined) {
      const min = Number(c.limits.min_amount);
      if (numAmount < min) {
        withinLimits = false;
        reasons.push(`amount ${query.amount} is below minimum limit (${c.limits.min_amount})`);
      }
    }

    if (c.limits?.max_amount !== undefined) {
      const max = Number(c.limits.max_amount);
      if (numAmount > max) {
        withinLimits = false;
        reasons.push(`amount ${query.amount} exceeds maximum limit (${c.limits.max_amount})`);
      }
    }

    const live = liveness(c);
    const runnable = live.runnable && !halted;

    if (live.state === "proven" && live.proof) {
      const hashPrefix = live.proof.stellar_tx_hash.slice(0, 8);
      reasons.push(`canary proof verified on-chain (${hashPrefix})`);
      if (live.proof.canary_max_amount !== undefined) {
        const cap = Number(live.proof.canary_max_amount);
        if (numAmount > cap) {
          withinLimits = false;
          reasons.push(
            `amount ${query.amount} exceeds canary cap (${live.proof.canary_max_amount})`,
          );
        }
      }
    } else if (live.state === "verified") {
      reasons.push(`dest endpoints confirmed ${live.verifiedAt}`);
      const DEFAULT_CANARY_CAP = 10.0;
      if (numAmount > DEFAULT_CANARY_CAP) {
        reasons.push(
          `unproven: amount ${query.amount} exceeds default canary cap (${DEFAULT_CANARY_CAP.toFixed(2)})`,
        );
      }
      if (!c.proof) {
        reasons.push("no canary proof on file (amounts capped at default)");
      }
    } else if (live.state === "unverified") {
      reasons.push("endpoints unverified (template or placeholder)");
    } else {
      reasons.push("missing required destination endpoints");
    }

    if (c.fx.quote_source === "external") {
      reasons.push("quote source: external (operator-supplied rate)");
    } else if (c.fx.quote_source === "sep38") {
      reasons.push("quote source: SEP-38 quote server");
    } else if (c.fx.quote_source === "native") {
      reasons.push("quote source: corridor-native rate");
    }

    const rate: string | undefined = undefined;
    const estimatedPayout: string | undefined = undefined;

    if (!query.offline) {
      const domain = c.dest.endpoints.home_domain;
      if (isPlaceholderDomain(domain)) {
        reasons.push("live query skipped: placeholder domain");
      } else {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        try {
          const fetchFn = opts.fetchImpl ?? fetch;
          const tomlUrl = `https://${domain}/.well-known/stellar.toml`;
          const res = await fetchFn(tomlUrl, {
            signal: controller.signal,
          });
          if (res.ok) {
            reasons.push("live: anchor stellar.toml reachable");
          } else {
            reasons.push(`live: anchor returned HTTP ${res.status}`);
          }
        } catch (e) {
          reasons.push(
            `live query: could not reach anchor (${e instanceof Error ? e.message : String(e)})`,
          );
        } finally {
          clearTimeout(timeoutId);
        }
      }
    }

    let baseLabel: RouteLabel;
    if (halted) {
      baseLabel = "HALTED";
    } else if (!withinLimits) {
      baseLabel = "INELIGIBLE";
    } else if (live.state === "proven") {
      baseLabel = "PROVEN";
    } else if (live.state === "verified") {
      baseLabel = "VERIFIED";
    } else if (live.state === "unverified") {
      baseLabel = "UNVERIFIED";
    } else {
      baseLabel = "NOT_RUNNABLE";
    }

    labels.push(baseLabel);

    let score: number;
    if (runnable && withinLimits) {
      if (baseLabel === "PROVEN") score = 1000;
      else if (baseLabel === "VERIFIED") score = 900;
      else score = 700;
    } else if (runnable) {
      score = 400; // runnable but over limit or cap
    } else if (baseLabel === "UNVERIFIED") {
      score = 300;
    } else if (baseLabel === "NOT_RUNNABLE") {
      score = 200;
    } else {
      score = 100;
    }

    evaluated.push({
      score,
      corridor: c,
      runnable,
      withinLimits,
      baseLabel,
      labels,
      reasons,
      rate,
      estimatedPayout,
    });
  }

  evaluated.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.corridor.id.localeCompare(b.corridor.id);
  });

  let topAssigned = false;
  return evaluated.map((item, index) => {
    const isTopRunnable =
      !topAssigned && item.runnable && item.withinLimits && item.score >= 700;
    if (isTopRunnable) {
      topAssigned = true;
      item.labels.unshift("RECOMMENDED");
    }

    return {
      rank: index + 1,
      corridorId: item.corridor.id,
      destName: item.corridor.dest.name,
      destDomain: item.corridor.dest.endpoints.home_domain,
      destAsset: item.corridor.dest.asset,
      country: item.corridor.compliance.dest_jurisdiction,
      protocol: protocolOf(item.corridor.dest),
      label: item.baseLabel,
      labels: item.labels,
      reasons: item.reasons,
      runnable: item.runnable,
      withinLimits: item.withinLimits,
      quoteSource: item.corridor.fx.quote_source,
      ...(item.estimatedPayout ? { estimatedPayout: item.estimatedPayout } : {}),
      ...(item.rate ? { rate: item.rate } : {}),
    };
  });
}
