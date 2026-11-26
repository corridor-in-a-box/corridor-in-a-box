// planRoutes(): the RFC 0004 route planner, composed from this package's
// building blocks. @corridor/service serves it as POST /routes and the CLI runs
// it as `corridor routes`. Steps, in RFC order (docs/rfcs/0004-smart-router.md §1,
// "Steps inside plan()"):
//
//   1. candidates()            corridors whose destination is destAsset in destCountry
//   2. filterByEvidence()      a fresh registry attestation for the corridor's protocol
//   3. lane check              NOT applied yet: the service has no lane-state source
//   4. filterByLimitsAndFields the manifest's min/max, with the engine's canary cap
//   5. filterByCircuitBreaker  the engine's lane breaker
//   6. price                   locked (firm SEP-38 quote) → indicative (SEP-38 GET /price)
//                              → estimated (rate history), within policy.allowedLabels
//   7. rank()                  cautious recipient amount, reliability, domain
//
// Every corridor that matched the destination but was ruled out comes back in
// `dropped` with the reason, so a business can see why a route was not offered.
// Nothing here moves money or opens a transaction: a firm quote is requested,
// never accepted.

import { sep38SellAsset, type Quote } from "@corridor/adapter-kit";
import { liveness, type Corridor } from "@corridor/manifest";
import { ALL_PRICE_LABELS, filterOptionsByAllowedLabels } from "./label-policy";
import { filterByCircuitBreaker, type BreakerStateReader } from "./breaker-filter";
import { candidates } from "./candidates";
import {
  DEFAULT_ESTIMATE_WINDOW_DAYS,
  DEFAULT_MIN_ESTIMATE_SPAN_DAYS,
  buildEstimatedOption,
  type RateSample,
} from "./estimated-price";
import { filterByEvidence } from "./evidence-filter";
import { requestLockedOption, type FirmQuoteCandidate } from "./firm-quote";
import { DEFAULT_ESTIMATE_MARGIN_BPS, fetchIndicativePrice } from "./indicative-price";
import { filterByLimitsAndFields } from "./limits-filter";
import { priceCandidatesInParallel } from "./parallel-pricer";
import type { PriceLabel, RouteOption, RouteRequest } from "./planner";
import { cautiousRecipientAmount, rank } from "./rank";
import { formatOptionReason } from "./reasons";
import { asAttestationSource, type AttestationSourceLike } from "./registry-resolver";
import { reliability, type ReliabilityRunStore } from "./reliability";
import {
  applyPrice,
  compareAmounts,
  isSettleableAmount,
  type Money,
  type PaymentIntent,
} from "@corridor/types";

/** Protocols an RFC 0004 `RouteOption` can name. */
type OptionProtocol = RouteOption["protocol"];

/** Where an `estimated` price's history comes from (RFC 0004 §3). */
export type RateHistorySource = (series: {
  /** The receiving anchor whose prices the samples are. */
  readonly receivingDomain: string;
  /** SEP-38 sell asset, e.g. `stellar:USDC:G…`. */
  readonly sellAsset: string;
  /** SEP-38 buy asset, e.g. `iso4217:NGN`. */
  readonly buyAsset: string;
  /** Oldest sample wanted, epoch ms. */
  readonly sinceMs: number;
}) => Promise<readonly RateSample[]>;

/**
 * What POST /routes plans with. Only `registry` is required: a planner never
 * offers an anchor without evidence, so a service with no attestation source
 * answers 501 instead of planning. Every other dependency is optional, and a
 * missing one removes a price label (with the reason) rather than inventing data.
 */
export interface RoutePlanningOptions {
  /** Attestation source, the same one `RegistryRouteResolver` reads. */
  readonly registry: AttestationSourceLike;
  /** Oldest attestation that still counts, in ledgers. Default: the resolver's one week. */
  readonly maxStalenessLedgers?: number;
  /**
   * Receiving-anchor adapter for a corridor, used to request a firm SEP-38
   * quote (`locked`). Never used to open a transaction. Without it no option
   * is `locked`.
   */
  readonly adapterFor?: (corridor: Corridor) => FirmQuoteCandidate["adapter"];
  /** fetch used for SEP-38 `GET /price` (`indicative`). Default: global fetch. */
  readonly fetch?: typeof fetch;
  /** Rate history for `estimated` prices. Without it no option is `estimated`. */
  readonly rateHistory?: RateHistorySource;
  /**
   * This business's run outcomes, for reliability (RFC 0004 §1 "Ranking").
   * Without it every anchor has no history, which `reliability()` scores 0.5
   * before the attestation-age discount.
   */
  readonly runs?: ReliabilityRunStore;
  /** Time allowed to price every candidate, in ms. Default 5000. */
  readonly pricingDeadlineMs?: number;
}

/**
 * One offered route: the RFC 0004 `RouteOption`, with `fees` present only when
 * the anchor stated a fee (a firm quote's `fee`). `recipientGets` is always
 * after fees. RFC 0004 types `fees` as required; a fee of "0" is not written
 * for a price that never said what its fee was.
 */
export type PlannedRouteOption = Omit<RouteOption, "fees"> & { readonly fees?: Money };

/** A corridor that matched the destination but is not offered, and why. */
export interface DroppedRoute {
  readonly corridorId: string;
  readonly receivingDomain: string;
  readonly protocol: string;
  readonly reason: string;
}

/** What POST /routes returns: ranked offers, then everything ruled out. */
export interface RoutePlan {
  readonly offered: readonly PlannedRouteOption[];
  readonly dropped: readonly DroppedRoute[];
}

/** Engine-side context the planner reads but does not own. */
export interface RoutePlanningContext {
  /** The engine's lane breaker store (`EngineDeps.health`). */
  readonly health?: BreakerStateReader;
  /** The engine's cap for unproven lanes (`EngineDeps.unprovenMaxAmount`). */
  readonly unprovenMaxAmount?: string;
  readonly now: () => number;
}

const DAY_MS = 86_400_000;

interface Candidate {
  readonly corridor: Corridor;
  readonly corridorId: string;
  readonly domain: string;
  readonly receivingDomain: string;
  readonly protocol: string;
  readonly asset: string;
}

interface PricedCandidate {
  readonly option: PlannedRouteOption;
  /** What rank() sorts by: the amount BEFORE any estimate margin (see rank.ts). */
  readonly rankAmount: string;
}

function dropOf(c: Candidate, reason: string): DroppedRoute {
  return {
    corridorId: c.corridorId,
    receivingDomain: c.receivingDomain,
    protocol: c.protocol,
    reason: reason.replace(/^dropped: /, ""),
  };
}

function isOptionProtocol(p: string): p is OptionProtocol {
  return p === "sep31" || p === "sep6" || p === "wallet";
}

/**
 * The most a single payment on this lane may be, worked out the way execute()
 * does: an unproven lane is held to its canary cap, and `max_amount` caps every
 * lane. Offering an amount the engine would then refuse is not an offer.
 */
function effectiveMax(
  corridor: Corridor,
  nowMs: number,
  unprovenMaxAmount?: string,
): string | undefined {
  const unproven = liveness(corridor, new Date(nowMs)).state !== "proven";
  const max = corridor.limits?.max_amount;
  if (!unproven) return max;
  const canaryCap = corridor.proof?.canary_max_amount ?? unprovenMaxAmount ?? "10";
  if (!max) return canaryCap;
  const cmp = compareAmounts(max, canaryCap);
  return cmp.ok && cmp.value <= 0 ? max : canaryCap;
}

/** The intent a firm quote is requested for. No transaction is ever opened with it. */
function planningIntent(req: RouteRequest, corridor: Corridor): PaymentIntent {
  return {
    idempotencyKey: `plan:${corridor.id}`,
    corridorId: corridor.id,
    sender: { id: "route-planner" },
    recipient: { id: "route-planner" },
    sourceAmount: req.sourceAmount,
  };
}

function quoteFee(quote: Quote): Money | undefined {
  return quote.fee ? { asset: quote.fee.asset, amount: quote.fee.amount } : undefined;
}

/**
 * Plan routes for `req` across `corridors`. Never throws for an anchor that is
 * down, refuses, or times out: that anchor is dropped with the reason.
 */
export async function planRoutes(
  req: RouteRequest,
  corridors: readonly Corridor[],
  opts: RoutePlanningOptions,
  ctx: RoutePlanningContext,
): Promise<RoutePlan> {
  const nowMs = ctx.now();
  const dropped: DroppedRoute[] = [];
  const policy = req.policy ?? {};
  const marginBps = policy.estimateMarginBps ?? DEFAULT_ESTIMATE_MARGIN_BPS;

  // 1. Candidates: destination asset and country, then the source asset.
  const matched: Candidate[] = [];
  const destination = { destAsset: req.destAsset, destCountry: req.destCountry };
  for (const corridor of candidates(destination, corridors).matching) {
    const domain = corridor.dest.endpoints.home_domain;
    const c: Candidate = {
      corridor,
      corridorId: corridor.id,
      domain,
      receivingDomain: domain,
      protocol: corridor.dest.protocol,
      asset: req.sourceAmount.asset,
    };
    const asset = req.sourceAmount.asset;
    if (asset !== corridor.source.asset && asset !== corridor.settlement.bridge_asset) {
      dropped.push(
        dropOf(c, `source asset ${asset} is not this corridor's source or bridge asset`),
      );
      continue;
    }
    if (corridor.settlement.network === "public") {
      const state = liveness(corridor, new Date(nowMs)).state;
      if (state === "unverified" || state === "not-runnable") {
        dropped.push(dropOf(c, `corridor is ${state} on the public network`));
        continue;
      }
    }
    matched.push(c);
  }

  // 2. Evidence: a fresh attestation for the corridor's own protocol.
  const evidence = await filterByEvidence(matched, {
    registry: opts.registry,
    ...(opts.maxStalenessLedgers !== undefined
      ? { maxStalenessLedgers: opts.maxStalenessLedgers }
      : {}),
  });
  for (const d of evidence.dropped) {
    dropped.push(dropOf(d.candidate, `${d.reason} for ${d.candidate.protocol}`));
  }

  // 3. Lane check: not applied. The service has no source of lane state yet.

  // 4. Limits, from the manifest (the engine enforces the same numbers). One
  //    candidate per call, so a drop maps back to its corridor even when two
  //    corridors share a receiving domain.
  const withinLimits: Candidate[] = [];
  for (const c of evidence.kept) {
    const max = effectiveMax(c.corridor, nowMs, ctx.unprovenMaxAmount);
    const min = c.corridor.limits?.min_amount;
    const checked = await filterByLimitsAndFields(
      [
        {
          ...c,
          capabilities: {
            ...(min !== undefined ? { minAmount: min } : {}),
            ...(max !== undefined ? { maxAmount: max } : {}),
          },
        },
      ],
      { sourceAmount: req.sourceAmount },
    );
    const refused = checked.dropped[0];
    if (refused) dropped.push(dropOf(c, refused.reason));
    else withinLimits.push(c);
  }

  // 5. Health: skip lanes whose breaker is open.
  let healthy: readonly Candidate[] = withinLimits;
  if (ctx.health) {
    const breaker = await filterByCircuitBreaker(withinLimits, ctx.health);
    const byCorridor = new Map(withinLimits.map((c) => [c.corridorId, c]));
    for (const d of breaker.dropped) {
      const c = d.corridorId !== undefined ? byCorridor.get(d.corridorId) : undefined;
      if (c) dropped.push(dropOf(c, d.reason));
    }
    healthy = breaker.offered;
  }

  // 6. Price, firmest allowed label first.
  const allowed = new Set<PriceLabel>(policy.allowedLabels ?? ALL_PRICE_LABELS);
  const priceOne = async (c: Candidate, timeoutMs: number): Promise<PricedCandidate> => {
    const protocol = c.protocol;
    if (!isOptionProtocol(protocol)) {
      throw new Error(`protocol ${protocol} cannot be offered as a route option`);
    }
    const failures: string[] = [];
    const base = { corridorId: c.corridorId, receivingDomain: c.receivingDomain, protocol };
    const destAsset = req.destAsset;
    const sellAsset = sep38SellAsset(c.corridor);

    for (const label of ALL_PRICE_LABELS) {
      if (!allowed.has(label)) continue;

      if (label === "locked") {
        if (!opts.adapterFor) {
          failures.push("locked: no quote adapter configured");
          continue;
        }
        const locked = await requestLockedOption(
          { domain: c.domain, corridor: c.corridor, adapter: opts.adapterFor(c.corridor) },
          planningIntent(req, c.corridor),
          { timeoutMs, now: ctx.now },
        );
        if (!locked.ok) {
          failures.push(`locked: ${locked.dropped.reason}`);
          continue;
        }
        const o = locked.option;
        const fees = quoteFee(o.quote);
        return {
          rankAmount: o.destAmount,
          option: {
            ...base,
            price: {
              label: "locked",
              rate: o.price.rate,
              quoteId: o.quoteId,
              expiresAt: o.expiresAt,
            },
            recipientGets: { asset: destAsset, amount: o.destAmount },
            ...(fees ? { fees } : {}),
            reliability: 0,
            reasons: [o.reason],
          },
        };
      }

      if (label === "indicative") {
        const quoteServer =
          "quote_server" in c.corridor.dest.endpoints
            ? c.corridor.dest.endpoints.quote_server
            : undefined;
        if (!quoteServer) {
          failures.push("indicative: no SEP-38 quote server in the manifest");
          continue;
        }
        const ind = await fetchIndicativePrice({
          domain: c.domain,
          protocol,
          quoteServer,
          context: protocol,
          sellAsset,
          buyAsset: destAsset,
          sellAmount: req.sourceAmount.amount,
          estimateMarginBps: marginBps,
          ...(opts.fetch ? { fetchImpl: opts.fetch } : {}),
        });
        if (!ind.ok) {
          failures.push(`indicative: ${ind.error.message}`);
          continue;
        }
        return {
          rankAmount: ind.value.destAmount,
          option: {
            ...base,
            price: { label: "indicative", rate: ind.value.price.rate },
            recipientGets: { asset: destAsset, amount: ind.value.destAmount },
            reliability: 0,
            reasons: [formatOptionReason({ kind: "indicative", source: "SEP-38 GET /price" })],
          },
        };
      }

      // estimated
      if (!opts.rateHistory) {
        failures.push("estimated: no rate history configured");
        continue;
      }
      const windowDays = policy.estimateWindowDays ?? DEFAULT_ESTIMATE_WINDOW_DAYS;
      // One day past the longer of the window and the minimum span, so a sample
      // sitting on the span boundary is not cut off (see estimated-price.ts).
      const lookbackDays = Math.max(windowDays, DEFAULT_MIN_ESTIMATE_SPAN_DAYS) + 1;
      const history = await opts.rateHistory({
        receivingDomain: c.receivingDomain,
        sellAsset,
        buyAsset: destAsset,
        sinceMs: nowMs - lookbackDays * DAY_MS,
      });
      const est = buildEstimatedOption({
        receivingDomain: c.receivingDomain,
        sourceAmount: req.sourceAmount,
        destAsset,
        history,
        policy: { estimateWindowDays: windowDays, estimateMarginBps: marginBps },
        nowMs,
      });
      if (est.status === "dropped") {
        failures.push(`estimated: ${est.reason.replace(/^dropped: /, "")}`);
        continue;
      }
      const atP25 = applyPrice(req.sourceAmount.amount, est.price.p25Rate);
      if (!atP25.ok) {
        failures.push(`estimated: ${atP25.error.message}`);
        continue;
      }
      return {
        rankAmount: atP25.value,
        option: {
          ...base,
          price: { label: "estimated", rate: est.price.rate, basis: est.price.basis },
          recipientGets: { asset: destAsset, amount: est.estimatedDestAmount.amount },
          reliability: 0,
          reasons: [
            formatOptionReason({
              kind: "estimated",
              sampleCount: est.price.sampleCount,
              windowDays: est.price.windowDays,
            }),
            policy.guaranteeEstimates
              ? "estimate guaranteed by the sending business"
              : "estimate not guaranteed",
          ],
        },
      };
    }

    throw new Error(
      failures.length > 0
        ? `unpriceable (${failures.join("; ")})`
        : "unpriceable (no price label allowed by policy)",
    );
  };

  const pricing = await priceCandidatesInParallel(
    healthy,
    async (c, context) => {
      const priced = await priceOne(c, context.timeoutMs);
      // rank() refuses a malformed amount for the whole batch; one anchor's
      // bad answer must cost only that anchor its place.
      if (!isSettleableAmount(priced.rankAmount)) {
        throw new Error(
          `unpriceable (${priced.option.price.label}: recipient amount is not a positive decimal)`,
        );
      }
      return priced;
    },
    opts.pricingDeadlineMs !== undefined ? { deadlineMs: opts.pricingDeadlineMs } : {},
  );
  for (const d of pricing.dropped) dropped.push(dropOf(d.candidate, d.reason));

  // Policy guard: priceOne only tries allowed labels, so this drops nothing
  // unless that rule is broken. It is the block that owns the rule.
  const labelled = pricing.priced.map(({ candidate, option: priced }) => ({
    candidate,
    priced,
    receivingDomain: candidate.receivingDomain,
    label: priced.option.price.label,
  }));
  const byLabel = filterOptionsByAllowedLabels(
    labelled,
    policy.allowedLabels ? { allowedLabels: policy.allowedLabels } : undefined,
  );
  for (const d of byLabel.dropped) dropped.push(dropOf(d.option.candidate, d.reason));

  // Reliability, then rank.
  const attestation = asAttestationSource(opts.registry);
  const runs: ReliabilityRunStore = opts.runs ?? { listOutcomes: () => [] };
  const scored = await Promise.all(
    byLabel.allowed.map(async ({ candidate, priced }) => ({
      receivingDomain: candidate.receivingDomain,
      price: { label: priced.option.price.label },
      recipientGets: { asset: req.destAsset, amount: priced.rankAmount },
      reliability: await reliability(candidate.receivingDomain, {
        runs,
        attestation,
        now: ctx.now,
      }),
      priced,
    })),
  );
  const ranked = rank(scored, { estimateMarginBps: marginBps });

  const offered = ranked.map((r, i): PlannedRouteOption => {
    const cautious = cautiousRecipientAmount(r, marginBps);
    const option = r.priced.option;
    return {
      ...option,
      reliability: r.reliability,
      reasons: [
        `ranked ${i + 1} of ${ranked.length}`,
        `attested for ${option.protocol}`,
        ...option.reasons,
        option.price.label === "locked"
          ? `ranked on the quoted ${cautious} ${req.destAsset}`
          : `ranked on ${cautious} ${req.destAsset} (${marginBps} bps margin off ${r.recipientGets.amount})`,
        `reliability ${r.reliability.toFixed(2)}`,
      ],
    };
  });

  return { offered, dropped };
}
