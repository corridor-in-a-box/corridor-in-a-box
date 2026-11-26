# Route planner guide: how a route is chosen

A sender says "send this amount to this country, in this currency". The route
planner turns that into a short, ranked list of ways to pay, each with an
honest price label and the reasons it ranked where it did. This page explains
the rules in plain words for businesses and contributors.

The design is [RFC 0004: Smart router](rfcs/0004-smart-router.md), sections 1,
2 and 5. The code-level seam the planner hands its choice to is
[docs/route-resolver.md](route-resolver.md).

> **What is built today.** `@corridor/router` ships the planner's types and its
> steps as separate building blocks, including the ranking function `rank()`
> ([#611]), and the engine falls back to the next route before funds move
> ([#626]). It does not ship a complete `RoutePlanner` that wires the steps
> together. Each section below says which parts exist and which are planned.

## What the planner does and does not do

- **It only decides.** The sending business's own signer executes the payment
  (RFC 0004, D1). The planner never holds funds, never holds a key and never
  signs anything.
- **It runs before the payment starts.** It replaces the caller picking a
  `corridorId` by hand. The chosen route is then pinned, so a payment that
  resumes after a restart goes back to the anchor the money was sent to.

```
RouteRequest ──▶ RoutePlanner.plan() ──▶ RouteOption[] (ranked)
                                              │ caller or policy picks one
                                              ▼
                       PaymentIntent{corridorId, pinned route} ──▶ execute()
                                              │
                         PinnedRouteResolver.resolve() returns the pinned anchor
```

The request and option types are exported from `@corridor/router`
(`packages/router/src/planner.ts`): `RouteRequest`, `RoutePolicy`,
`PriceLabel`, `RouteOption` and `RoutePlanner`.

## The steps

A planner works through seven steps. Every route it drops keeps the reason, so
a business can see why a route was not offered.

| #   | Step           | In plain words                                                                                                                                                                                  | On main today                                                                                                                                                           |
| --- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Candidates** | Take the corridors this business has configured whose destination matches the requested currency and country.                                                                                   | `candidates()` ([#604])                                                                                                                                                 |
| 2   | **Evidence**   | Keep only anchors with a fresh registry attestation for the corridor's protocol. Unknown is refused, never assumed.                                                                             | `filterByEvidence()` ([#605]), the same check `RegistryRouteResolver` makes                                                                                             |
| 3   | **Lane check** | Keep only receiving anchors that have onboarded _this_ sending business.                                                                                                                        | `checkLane()`, a SEP-10 login with the business's own key                                                                                                               |
| 4   | **Limits**     | Drop anchors whose minimum or maximum excludes the amount, or that need details the request cannot supply.                                                                                      | `filterByLimitsAndFields()` ([#606])                                                                                                                                    |
| 5   | **Health**     | Drop anchors whose circuit breaker is open.                                                                                                                                                     | `filterByCircuitBreaker()` ([#607])                                                                                                                                     |
| 6   | **Price**      | Ask each remaining anchor for a price and label it (see [the three labels](#the-three-labels)). An anchor with no price and not enough rate history is returned as unpriceable and ranked last. | `requestLockedOption()` ([#608]), `fetchIndicativePrice()` ([#609]), `buildEstimatedOption()` ([#610]), `priceCandidatesInParallel()`, `filterOptionsByAllowedLabels()` |
| 7   | **Rank**       | Order what is left by [the ranking rule](#the-ranking-rule) and return every option, including the dropped ones with their reason.                                                              | `rank()` ([#611]), `reliability()` ([#612]) and reasons on every option ([#613]).                                                                                       |

## The three labels

Every price carries exactly one of three labels (RFC 0004, D2 and section 2).
They tell the sender how firm the amount is.

| Label        | Shown to the sender as                                                    | Where the price comes from                                                                             |
| ------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `locked`     | "Recipient gets ₦X. Locked for 60 s."                                     | A firm SEP-38 quote. It carries a quote id and an expiry.                                              |
| `indicative` | "About ₦X. Final amount set at payout."                                   | The anchor's current price (SEP-38 `/price`, or a rate it publishes). Not promised.                    |
| `estimated`  | "At least ₦X (estimated)" if guaranteed, otherwise "About ₦X (estimated)" | Our [rate history](rate-history.md): the lower quartile (P25) of the last 7 days, minus a 0.5% margin. |

- Labels are never mixed or rounded into each other. In many places the law
  requires an estimate to be shown as an estimate.
- An anchor gets `estimated` only with at least 7 days of history and at least
  100 samples in the window. Below that it is unpriceable.
- A business's legal team decides which labels it may show.
  `policy.allowedLabels` enforces that; `filterOptionsByAllowedLabels()` drops
  the other options with a reason.
- A business can choose to guarantee estimated prices
  (`policy.guaranteeEstimates`, off by default). It then pays the shown amount
  and covers any difference from its own funds. The engine records that
  difference on each run as `estimateGap` (the anchor's actual payout minus the
  guaranteed amount), returned on `GET /payments/:key` ([#627]).

## The ranking rule

Options are ranked by **what the recipient gets, priced cautiously**, then by
reliability, then by speed:

1. **What the recipient gets**, counted cautiously for each label:
   - `locked`: the quoted amount.
   - `indicative`: the indicative amount minus the estimate margin, because it
     is not promised.
   - `estimated`: the P25 amount minus the margin.
2. **Reliability**: this business's own success rate on that anchor over the
   last 30 days, scaled down when the anchor's attestation is old.
3. **Speed**: ties go to the faster anchor.

The ranking is deterministic: the same request gives the same order, with no
hidden weights and no randomness. Every option carries `reasons`, so any
choice can be explained to the sender and checked later.

On main, the pricing steps already produce the cautious amounts:
`requestLockedOption()` and `fetchIndicativePrice()` return a
`cautiousDestAmount` (the indicative one minus `DEFAULT_ESTIMATE_MARGIN_BPS`,
50 basis points), and `buildEstimatedOption()` applies the same margin to the
P25 rate. The reliability score is `reliability()` ([#612], see
[Reliability](route-resolver.md#reliability)): with fewer than
20 runs in the window it is pulled toward 0.5, so one early result cannot
decide it, and it falls to 0 as the attestation reaches the one-week freshness
bound.

`rank(options, { estimateMarginBps })` ([#611]) applies the rule. It takes any
option with `receivingDomain`, `price.label`, `recipientGets`, `reliability`
and an optional `estimatedDeliveryMs` (a full `RouteOption` works), and
returns a new array ordered by the cautious amount, then reliability, then
delivery time (an unknown time loses the tie), then receiving domain. Options
equal on every key keep their input order. `cautiousRecipientAmount` exposes
the cautious-amount step on its own. Options in different assets, a malformed
amount, an unknown label or a reliability outside 0..1 throw a `RangeError`
rather than rank silently wrong.

## The fallback rule

What happens when the chosen route fails depends on whether money has moved:

- **Before funds move** (the quote is refused, KYC is rejected, or opening the
  transaction fails): the run is marked failed, and a new run starts on the next
  option with a derived idempotency key, `<key>:alt1`. The audit trail links
  the two runs.
- **After settlement starts**: never switch. Recovery follows the existing
  refund path.

This is on main ([#626]). A resolver offers the next options as
`RouteDecision.alternates`, an ordered list of `RouteCandidate`s (receiving
anchor, optional sending anchor, trust). When the primary route fails before
funds move, the engine tries them as linked runs under `<key>:alt1`,
`<key>:alt2`, and so on, up to `maxAlternates` in `EngineDeps` (default 2; `0`
turns fallback off). The audit trail links the runs with `fallbackTo` and
`fallbackFrom`. A resolver that returns no `alternates`, such as the shipped
`StaticRouteResolver` and `RegistryRouteResolver`, gets no fallback. Once a
run reaches `settling` no other route is tried, and a resumed run whose route
now resolves to a different receiving domain than the one stored on it is
refused with `ROUTE_PINNED`.

## Route types

| Type     | Status    | How the money moves                                                                                                               | What must be true first                                                                                                           |
| -------- | --------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `sep31`  | available | Anchor to anchor. The receiving anchor pays the recipient.                                                                        | The anchor is attested and the lane is open to this business.                                                                     |
| `sep6`   | next      | The business withdraws through SEP-6 straight to the recipient's account.                                                         | The manifest declares `third_party_payout: true`, confirmed with the anchor ([#644]). `candidates()` drops it otherwise ([#645]). |
| `wallet` | in build  | A plain Stellar payment of the corridor's asset (for example USDC) to the recipient's own wallet. The recipient cashes out later. | The recipient has a wallet that can hold the asset.                                                                               |

**SEP-31** is the Stellar standard for one licensed business paying another. It
runs without a person in the loop, which is what a payment engine needs.

**SEP-6 and the third-party caveat.** SEP-6 was designed for a customer moving
their own money in or out of an anchor. Here the business pays out to someone
else, a third party. Not every anchor allows that, and no automatic probe can
tell. So a SEP-6 route is only offered when the corridor manifest says
`third_party_payout: true` and that has been confirmed with the anchor. The
flag is on main ([#644]): only a `protocol: sep6` corridor may carry it, and
`third_party_payout: true` needs a `third_party_payout_note` saying who
confirmed it and when. `allowsThirdPartyPayout()` in `@corridor/manifest` reads
it. `candidates()` offers a SEP-6 corridor only when it is set, and otherwise
drops it with the reason `SEP6_THIRD_PARTY_PAYOUT_REASON` ([#645]).

**Wallet.** No receiving anchor is involved and nothing is converted: the
recipient gets the corridor's asset in their own wallet and cashes out through
an anchor of their choice. The engine never drives SEP-24 for this ([RFC
0003](rfcs/0003-sep24-interactive-handoff.md)). On main, the `protocol: wallet`
manifest shape ([#646]) and `WalletAdapter` in `@corridor/stellar` ([#647])
exist. Checking the recipient's trustline before sending is planned ([#648]).

## How to plug in a custom planner

A business can write its own planner without forking this repository. There
are three parts: the planner itself, the conformance suite, and handing its
choice to the engine.

### 1. Implement `RoutePlanner`

Implement the `RoutePlanner` interface from `@corridor/router`. It has one
method, `plan(req: RouteRequest): Promise<ReadonlyArray<RouteOption>>`. Build
it from the step functions above rather than re-writing them, so the evidence,
limits and breaker rules stay the ones this repo tests:

```ts
import type { Corridor } from "@corridor/manifest";
import {
  candidates,
  filterByEvidence,
  type AttestationSource,
  type RouteOption,
  type RoutePlanner,
  type RouteRequest,
} from "@corridor/router";

class MyPlanner implements RoutePlanner {
  constructor(
    private readonly corridors: readonly Corridor[],
    private readonly registry: AttestationSource,
  ) {}

  async plan(req: RouteRequest): Promise<ReadonlyArray<RouteOption>> {
    // Step 1: configured corridors whose destination matches.
    const { matching } = candidates(req, this.corridors);

    // Step 2: keep only anchors the registry vouches for.
    const { kept, dropped } = await filterByEvidence(
      matching.map((corridor) => ({
        domain: corridor.dest.endpoints.home_domain,
        protocol: corridor.dest.protocol,
        corridor,
      })),
      { registry: this.registry },
    );

    // Steps 3 to 7: lane check, limits, breaker, price, rank.
    // Keep `dropped` and every reason: the sender and the audit trail need them.
    // ...
  }
}
```

Your planner may rank differently from the rule above. If it does, document
the rule, keep it deterministic, and keep the three labels.

### 2. Prove it with `describePlannerContract`

`@corridor/router/testing` ships the planner's contract as vitest cases:

- an unattested option is never offered;
- every dropped option carries a reason;
- the same input yields the same order;
- every label is `locked`, `indicative` or `estimated`.

The suite is structural. It needs `plan(input)` to return `{ offered, dropped }`,
where each offered option has a `domain` and a `label` and each dropped option a
`domain` and a `reason`. `RouteOption[]` alone has no place for dropped routes,
so test through a thin wrapper that returns both. The fixtures must name at
least one unattested domain in `input`:

```ts
import { describePlannerContract } from "@corridor/router/testing";

describePlannerContract("MyPlanner", () => myPlannerWithDrops, {
  input: myRouteRequest,
  unattestedDomains: ["not-attested.example"],
});
```

The full contract, and `checkPlannerContract` / `expectPlannerContract` for
asserting the suite fails a broken planner, are in
[Conformance: `describePlannerContract`](route-resolver.md#conformance-describeplannercontract).

### 3. Hand the choice to the engine

The planner chooses; the engine pays. What exists today to connect the two:

- **The sender's choice on `POST /payments`.** `@corridor/service` accepts a
  signed `routeOption` (corridor, receiving anchor, protocol, label and, for a
  `locked` option, the quote the sender was shown). Sign it with
  `signRouteOption()`. A locked quote reaches the engine as
  `ExecuteOptions.quote`, so it is honoured, or refused once expired, instead
  of being re-quoted at a different price.
- **Pinning.** The engine stores the receiving domain and protocol on the run,
  and `PinnedRouteResolver` resolves a resumed run only to that anchor.
- **Your own `RouteResolver`.** To load custom resolution logic at deploy time,
  follow [Writing your own](route-resolver.md#writing-your-own): export
  `apiVersion` and a factory, point `CORRIDOR_RESOLVER_MODULE` at it, and run
  `describeResolverContract` over it. Return a `ranking` from `resolve()` to
  [record the choice](route-resolver.md#recording-the-choice) and its reasons
  in the audit trail, and the next-best options as `alternates` so the engine
  can [fall back](#the-fallback-rule) to them before funds move.

[#604]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/604
[#605]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/605
[#606]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/606
[#607]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/607
[#608]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/608
[#609]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/609
[#610]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/610
[#611]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/611
[#612]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/612
[#613]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/613
[#626]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/626
[#627]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/627
[#644]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/644
[#645]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/645
[#646]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/646
[#647]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/647
[#648]: https://github.com/corridor-in-a-box/corridor-in-a-box/issues/648
