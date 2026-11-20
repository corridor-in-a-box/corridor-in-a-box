# RFC 0004: Smart router and route planner

- Status: accepted
- Issue: [#620](https://github.com/corridor-in-a-box/corridor-in-a-box/issues/620)
- Related: [RFC 0001](0001-protocol-agnostic-corridors.md) (protocol-agnostic corridors), [RFC 0002](0002-source-side-funding.md) (source-side funding), [`docs/route-planner.md`](../route-planner.md), [`docs/route-resolver.md`](../route-resolver.md)

## Summary

The engine orchestrates payments along a corridor through the five canonical
verbs (`quote → comply → open → settle → reconcile`). While early implementations
assumed a 1:1 binding between a payment intent and a static corridor manifest,
real-world remittance corridors involve multiple competing receiving anchors,
varying liquidity and fee structures, differing counterparty risk profiles, and
dynamic attestation freshness.

This RFC defines the architectural contract for the **Smart Router and Route Planner**:
how candidate corridors are discovered, filtered, and gated against verifiable on-chain
facts; how the three operational labels (`proven`, `verified`, `unverified`) govern
execution safety; the deterministic ranking and fallback rules; the protocol
distinctions between SEP-31, SEP-6, and non-target wallets; and the open extension
point for plugging in custom routing intelligence without forking the engine.

## Vocabulary

- **Route Planner**: The component implementing `RouteResolver` that maps a
  `PaymentIntent` and candidate corridors to a binding `RouteDecision`.
- **RouteDecision**: An immutable decision object specifying the chosen `receiving`
  adapter, optional `sending` adapter, `trust` mode (`"attested"` vs `"manifest"`),
  and optional `split` routing weights.
- **Attestation Gate**: On-chain verification via Soroban registry confirming that
  an anchor actively serves the declared protocol within freshness bounds.
- **Operational Labels**: Verification tiers for corridors (`proven`, `verified`,
  `unverified`, and `not-runnable`).
- **Ranking Rule**: The deterministic hierarchy used to sort multiple viable candidate
  routes for a single currency corridor.
- **Fallback Rule**: The safety policy determining when and how an alternative route
  is selected when the primary candidate is unavailable, enforcing fail-closed
  semantics.
- **Third-Party Caveat**: The architectural constraint that SEP-6 off-ramps must
  explicitly permit programmatic, server-to-server third-party settlement.

## The Routing Pipeline

Routing execution proceeds in six deterministic stages:

```text
PaymentIntent
     │
     ▼
[ 1. Discovery ]       ─── Locate candidate manifests matching source & target assets
     │
     ▼
[ 2. Attestation ]     ─── Gate against on-chain registry (serves protocol? fresh? toml hash?)
     │
     ▼
[ 3. Liveness Check ]  ─── Verify breaker health (consecutive_failures < 3) & payment caps
     │
     ▼
[ 4. Ranking ]         ─── Sort viable candidates deterministically (proof > fresh > cost)
     │
     ▼
[ 5. Decision ]        ─── Construct immutable RouteDecision { receiving, trust, split }
     │
     ▼
[ 6. Fallback ]        ─── Fail closed if primary fails; never silently weaken trust
```

### 1. Discovery

The planner matches `PaymentIntent.sourceAmount.asset` and target currency/jurisdiction
against available `Corridor` manifests. Candidates missing mandatory endpoints
outright are classified as `not-runnable` and discarded immediately.

### 2. Attestation

For each candidate anchor, the planner queries the on-chain registry:

```ts
interface AttestationSource {
  serves(domain: string, protocol: AttestedProtocol): Promise<boolean>;
  staleness(domain: string): Promise<number>;
  tomlHash(domain: string): Promise<string>;
}
```

- The query asks about `protocolOf(corridor.dest)` (`sep31` or `sep6`).
- Attestations older than `maxStalenessLedgers` (default 120,960 ledgers / ~1 week)
  are rejected.
- A failure in registry communication or an unattested anchor causes the gate to
  fail closed by throwing `UnattestedAnchorError`.

### 3. Liveness and safety

- **Circuit Breaker:** Lanes with consecutive failures exceeding the configured
  threshold (`consecutive_failures`, default 3) are halted (`CORRIDOR_HALTED`).
- **Payment Limits:** Payment amounts are bounded by `limits.min_amount` and
  `limits.max_amount`. Lanes not yet marked `proven` enforce `proof.canary_max_amount`
  as a safety ceiling.

### 4. Ranking

Viable candidates are ordered by the **Ranking Rule**:

1. Proof tier: `proven` > `verified` > `unverified`.
2. Freshness: Anchors attested more recently (lower staleness) take priority.
3. Health: Corridors with zero faults take priority over corridors with prior faults.
4. Cost & Net Delivery: Routes offering superior net destination delivery for the
   given source amount (evaluated via SEP-38 quotes).
5. Latency: Lower historical reconciliation latency.

### 5. Decision formation

The highest-ranked candidate is wrapped in `RouteDecision`:

```ts
interface RouteDecision {
  readonly receiving: AnchorAdapter;
  readonly sending?: SourceAnchorAdapter;
  readonly split?: ReadonlyArray<{ adapter: AnchorAdapter; weight: number }>;
  readonly trust: "attested" | "manifest";
}
```

`trust` is set honestly to `"attested"` when verified through registry evidence,
or `"manifest"` if executing under explicit operator opt-in
(`trustManifestWithoutAttestation`).

### 6. Fallback

If the primary route fails attestation or circuit breaker checks prior to settlement:

- The planner evaluates the next candidate in the ranked list.
- **Fail-closed invariant:** An attested route failure must NEVER silently fall back
  to an unverified or manifest-trusted route.
- If no alternatives satisfy the attestation gate, the planner throws `UnattestedAnchorError`
  (propagated as `ROUTE_REFUSED` / HTTP 503).
- Fallback is strictly pre-settlement; once the on-chain settlement transaction is
  submitted, the route is locked.

## The Three Labels

| Label            | Criteria                                                                                                                                                                      | Production Runnable?                    |
| :--------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------- |
| **`proven`**     | Endpoints verified against live `stellar.toml`; real canary payment reached `completed` within `max_age_days` (default 30) with tx hashes recorded in manifest `proof` block. | Yes (full capacity)                     |
| **`verified`**   | Endpoints verified against live `stellar.toml` on recorded `endpoints_verified_at`; on-chain attestation active.                                                              | Yes (capped by canary limit)            |
| **`unverified`** | Endpoints declared in manifest but never independently verified against TOML or probed on-chain.                                                                              | No (refused by `RegistryRouteResolver`) |

## Protocol Archetypes

1. **SEP-31 (Direct Anchor-to-Anchor)**: The primary transfer protocol for
   unattended, corporate B2B remittances. Non-interactive, programmatic, and
   memo-correlated.
2. **SEP-6 (Programmatic Deposit/Withdraw) with Third-Party Caveat**: Programmatic
   off-ramp using `POST /withdraw-exchange`. Caveat: Many SEP-6 anchors assume
   retail 1st-party clients; operators must verify that the anchor accepts
   third-party enterprise settlements without interactive browser sessions.
3. **Wallets (Non-Targets)**: Non-custodial or retail consumer applications
   (e.g. Vibrant). They are clients of the network, not anchors, and publish no
   SEP-31/SEP-6 receive endpoints. Corridors cannot route into wallet domains.

## Extensibility Seam

External routing intelligence (e.g. proprietary order-routing engines or private
scoring models) is loaded via `loadResolver(spec, ctx)`:

- Factory interface: `(ctx, options) => RouteResolver`
- Contract version: `export const apiVersion = 1;`
- Injected via `CORRIDOR_RESOLVER_MODULE` and `CORRIDOR_RESOLVER_OPTIONS`.
- Conformance verified via `@corridor/router/testing`'s `describeResolverContract`.

## Invariants

1. **No Silent Weakening:** The router must never downgrade trust requirements
   on fallback. A failure of an attested route must never silently route through
   an unverified manifest.
2. **Deterministic Output:** For the same `intent` and `corridor`, `resolve()`
   must return the identical receiving anchor across repeated calls and process
   restarts.
3. **Pre-Settle Locking:** Route decisions cannot be mutated once settlement has
   been initiated on-chain.
4. **Honest Reporting:** `decision.trust` must report `"attested"` only when
   on-chain evidence verified the anchor.
