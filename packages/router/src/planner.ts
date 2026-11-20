// Route planner interface and types (RFC 0004 §1).
//
// A RoutePlanner evaluates candidate corridors for a payment and returns
// offered options (each with a PriceLabel and cautious payout amount) alongside
// dropped options (each with a human-readable refusal reason).

import type { Money } from "@corridor/types";

/** How firmly a route option's quoted rate is held. */
export type PriceLabel = "locked" | "indicative" | "estimated";

/** Optional routing policy constraints supplied with a planning request. */
export interface PlannerPolicy {
  /** Number of trailing days of rate history to consult for estimated fallbacks. */
  readonly estimateWindowDays?: number;
  /** Safety margin in basis points subtracted from non-locked prices when ranking. */
  readonly estimateMarginBps?: number;
  /** Restrict offered options to these price labels; others are dropped with a reason. */
  readonly allowedLabels?: readonly PriceLabel[];
  /** Overall deadline in milliseconds for planning across all candidates. */
  readonly deadlineMs?: number;
  /** Maximum milliseconds to wait for an individual candidate anchor's price response. */
  readonly perAnchorTimeoutMs?: number;
}

/** Input passed to a RoutePlanner describing the payment to price and filter. */
export interface RouteRequest {
  /** Source amount and asset supplied by the sender. */
  readonly sourceAmount: Money;
  /** Destination payout asset code (for example, `"iso4217:NGN"`). */
  readonly destAsset: string;
  /** Optional corridor identifier restricting candidate selection. */
  readonly corridorId?: string;
  /** Transaction field names already supplied by the caller for required-field checks. */
  readonly suppliedFields?: Readonly<Record<string, string>>;
  /** Policy overrides governing quote windows, margins, timeouts, and allowed labels. */
  readonly policy?: PlannerPolicy;
}

/** Price breakdown and firmness metadata for a planned route option. */
export interface RoutePrice {
  /** Whether the rate is locked by a firm quote, indicative from a live feed, or estimated. */
  readonly label: PriceLabel;
  /** Quoted or estimated destination units per 1 source unit, as a decimal string. */
  readonly rate: string;
  /** Unadjusted destination payout amount as a decimal string. */
  readonly destAmount: string;
  /** Cautious destination amount after applying any margin discount, used for ranking. */
  readonly cautiousDestAmount: string;
  /** Human-readable provenance note for estimated prices (for example, sample count and window). */
  readonly basis?: string;
  /** Anchor firm-quote identifier when `label === "locked"`. */
  readonly quoteId?: string;
  /** Epoch milliseconds at which a locked quote expires. */
  readonly expiresAt?: number;
}

/** A candidate route evaluated and offered to the caller or engine. */
export interface RouteOption {
  /** Receiving anchor's canonical home domain. */
  readonly domain: string;
  /** Receiving anchor domain persisted with the payment run (matches `domain`). */
  readonly receivingDomain: string;
  /** Protocol spoken by the destination route (for example, `"sep31"` or `"sep6"`). */
  readonly protocol: string;
  /** Price firmness label matching `price.label`. */
  readonly label: PriceLabel;
  /** Detailed pricing breakdown for this candidate. */
  readonly price: RoutePrice;
  /** Cautious destination amount promoted to top-level for deterministic ranking. */
  readonly cautiousDestAmount: string;
  /** Unadjusted destination payout amount as a decimal string. */
  readonly destAmount: string;
  /** Anchor firm-quote identifier when `label === "locked"`. */
  readonly quoteId?: string;
  /** Epoch milliseconds at which a locked quote expires. */
  readonly expiresAt?: number;
  /** Historical success rate in `[0, 1]` used as a ranking tiebreaker. */
  readonly reliability?: number;
  /** Expected end-to-end delivery duration in milliseconds used as a ranking tiebreaker. */
  readonly estimatedDeliveryMs?: number;
  /** Human-readable explanation describing why this option has its label and state. */
  readonly reason: string;
}

/** A candidate route excluded by filtering, policy, timeouts, or circuit breakers. */
export interface DroppedRouteOption {
  /** Receiving anchor's canonical home domain. */
  readonly domain: string;
  /** Receiving anchor domain matching `domain`. */
  readonly receivingDomain: string;
  /** Protocol of the candidate route when known. */
  readonly protocol?: string;
  /** Price firmness label if pricing completed before a policy filter dropped the option. */
  readonly label?: PriceLabel;
  /** Marker distinguishing dropped candidates from offered options. */
  readonly dropped: true;
  /** Human-readable explanation of why the candidate was dropped. */
  readonly reason: string;
}

/** Output produced by planning candidate routes for a `RouteRequest`. */
export interface RoutePlan {
  /** The request that generated this plan. */
  readonly request: RouteRequest;
  /** Ranked, eligible route options available for payment execution. */
  readonly offered: readonly RouteOption[];
  /** Candidate routes excluded during planning, each carrying a reason. */
  readonly dropped: readonly DroppedRouteOption[];
}

/** Produces ranked offered route options and reasoned drops for a payment request. */
export interface RoutePlanner {
  /** Evaluate candidate corridors for `request` and return offered and dropped options. */
  plan(request: RouteRequest): Promise<RoutePlan>;
}
