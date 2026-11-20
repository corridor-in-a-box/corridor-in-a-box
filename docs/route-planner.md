# Route planner guide: how a route is chosen

`corridor-in-a-box` is an open, manifest-driven engine for cross-border payment
corridors on Stellar. One of its architectural boundaries is the **router seam**:
the engine never hard-codes where a payment goes or which anchor receives it.
Instead, a **route planner** evaluates the payment intent, checks verifiable
facts, ranks candidate lanes, and returns a binding `RouteDecision`.

This guide explains in plain words how a route is chosen. It is written for
fintech operators, remittance businesses, and open-source contributors who need
to understand the decision rules, the safety guarantees, and how to plug in
custom routing logic.

For the underlying architectural specification, see [RFC 0004: Smart router](rfcs/0004-smart-router.md).
For the code-level module contract and loader API, see [docs/route-resolver.md](route-resolver.md).

---

## 1. Core architecture & separation of concerns

To understand route selection, it helps to separate four distinct layers:

```text
┌────────────────────────────────────────────────────────────────────────┐
│ 1. Engine (@corridor/engine)                                           │
│    Orchestrates the payment lifecycle state machine:                   │
│    quote → comply → open → settle → reconcile                          │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ delegates destination selection
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 2. Route Planner (@corridor/router)                                    │
│    Evaluates intent, verifies evidence, ranks candidates, and selects  │
│    the receiving (and optional sending) anchor adapter.                │
└──────────────────┬───────────────────────────────┬─────────────────────┘
                   │ reads static configuration    │ checks verified facts
                   ▼                               ▼
┌────────────────────────────────────┐ ┌─────────────────────────────────┐
│ 3. Manifests (@corridor/manifest)  │ │ 4. Registry (@corridor/registry)│
│    Declarative *.corridor.yaml     │ │    On-chain Soroban contract of │
│    files specifying endpoints,     │ │    independently probed facts:  │
│    assets, limits, and rules.      │ │    serves protocol? fresh? hash?│
└────────────────────────────────────┘ └─────────────────────────────────┘
```

1. **The Engine** owns payment execution, idempotency, and recovery. It does not
   know about exchange rates, anchor health scores, or country preferences.
2. **The Route Planner** implements `RouteResolver`. It examines the `PaymentIntent`
   and available corridors, filters out unsafe or dead lanes, and picks the best
   route.
3. **The Manifest** (`*.corridor.yaml`) declares what a corridor claims to do:
   assets, protocols, endpoint URLs, settlement limits, and recovery parameters.
4. **The Registry** records what anchors _demonstrably_ do on-chain: whether
   automated attesters verified the anchor's endpoints and SEP compliance, when
   that was last checked, and the cryptographic hash of its `stellar.toml`.

---

## 2. The steps: how a route is evaluated

When a payment intent is processed (or resumed after a crash), the route planner
moves through six deterministic steps:

```text
PaymentIntent
     │
     ▼
[ Step 1: Candidate Gathering ] ─── Filter manifests by source & dest asset/country
     │
     ▼
[ Step 2: Attestation Gating ]  ─── Query on-chain registry: serves protocol? fresh?
     │
     ▼
[ Step 3: Liveness & Safety ]   ─── Check breaker status, limits & verification tier
     │
     ▼
[ Step 4: Ranking Rule ]        ─── Sort viable candidates by proof, freshness & cost
     │
     ▼
[ Step 5: Decision Formation ]  ─── Construct RouteDecision (adapter, trust, split)
     │
     ▼
[ Step 6: Fallback Handling ]   ─── If primary fails, fall back without weakening trust
```

### Step 1: Candidate gathering

The planner inspects the incoming `PaymentIntent` (source amount, source asset,
and target currency or destination country). It identifies candidate corridor
manifests whose `source.asset` and `dest.asset` match the payment requirement.

### Step 2: Attestation gating

For each candidate, the planner checks whether the receiving anchor has valid
evidence in the on-chain registry:

- **Protocol match:** Does the anchor demonstrably serve the protocol declared in
  the manifest (`serves(domain, protocol)`)? A SEP-31 corridor is checked against
  the SEP-31 probe; a SEP-6 corridor is checked against the SEP-6 probe.
- **Freshness bound:** Is the attestation fresh? By default, attestations older
  than `120,960` ledgers (~1 week at 5s ledgers) are treated as expired.
- **TOML hash verification:** Does the anchor's live `stellar.toml` match the
  attested SHA-256 hash?

If the registry cannot be reached or has no passing record for the anchor, the
gate **fails closed**. An unverified anchor is never routed through on trust.

### Step 3: Liveness & safety evaluation

Candidates that pass attestation are checked against operational constraints:

- **Circuit Breaker:** Has the lane tripped? If a corridor suffered consecutive
  settlement/reconcile failures (default 3), the lane is halted (`CORRIDOR_HALTED`).
  Halted corridors are excluded from routing until an operator explicitly resets them.
- **Amount boundaries:** Does the payment amount fit within the manifest's
  `limits.min_amount` and `limits.max_amount`? If a corridor defines a canary cap
  (`canary_max_amount`), payments above that cap are restricted unless the lane has
  graduated to `proven`.
- **Liveness label:** Is the manifest labeled `proven`, `verified`, or `unverified`?

### Step 4: Candidate ranking

Remaining viable candidates are ordered using the **Ranking Rule** (detailed
below), sorting the best route to the top based on proof quality, attestation
freshness, uptime, and pricing.

### Step 5: Decision formation

The planner selects the top-ranked candidate and constructs an immutable
`RouteDecision`:

```ts
interface RouteDecision {
  readonly receiving: AnchorAdapter;
  readonly sending?: SourceAnchorAdapter;
  readonly trust: "attested" | "manifest";
  readonly split?: ReadonlyArray<{ adapter: AnchorAdapter; weight: number }>;
}
```

- `receiving`: The instantiated adapter ready to execute the destination leg.
- `sending`: The source adapter if source funding is required (e.g. SEP-6 deposit).
- `trust`: `"attested"` when verified against on-chain evidence, or `"manifest"`
  when running under an explicit operator override.
- `split`: Reserved for multi-anchor routing (weights must sum to 1.0).

### Step 6: Fallback handling

If the top candidate becomes unresolvable before settlement begins, the planner
applies the **Fallback Rule** to attempt the next qualified candidate without
degrading security.

---

## 3. The three labels

Every route candidate is classified under one of three operational labels. These
labels prevent fictional or unconfirmed endpoints from masquerading as healthy:

| Label            | What it means                                                                                                                                                                                  | Attestation required? | Production runnable?                        |
| :--------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------- | :------------------------------------------ |
| **`proven`**     | **Gold standard.** Endpoints verified, and a real canary payment through this exact lane has settled and completed within `max_age_days` (default 30d). Proof block holds immutable tx hashes. | Yes                   | Yes (full capacity)                         |
| **`verified`**   | **Standard production.** Endpoints checked against the anchor's published `stellar.toml` on a recorded date (`endpoints_verified_at`), and on-chain attestation is active.                     | Yes                   | Yes (subject to canary limits)              |
| **`unverified`** | **Untrusted / draft.** Endpoints are declared in YAML, but no human or attester has confirmed they resolve. Default for new manifests.                                                         | No                    | **No** (refused by `RegistryRouteResolver`) |

> [!IMPORTANT]
> If a manifest is missing a required endpoint outright (e.g. no `transfer_server`
> or `transfer_server_sep31`), its state is **`not-runnable`**. It cannot settle
> under any circumstances and is immediately discarded during candidate gathering.

### Why the three labels matter to businesses

A common trap in cross-border systems is treating configuration as proof of life.
Writing `https://example.com/sep31` in a YAML file does not mean the server exists,
that the anchor's KYC server answers, or that money can settle.

- **`unverified` lanes are blocked by default.** `RegistryRouteResolver` throws
  `UnattestedAnchorError`, which maps to `ROUTE_REFUSED` (HTTP 503).
- **`verified` lanes permit automated execution**, ensuring that both DNS and SEP
  capabilities answered an automated probe.
- **`proven` lanes provide cryptographic auditability**, proving that real funds
  traversed the entire chain from quote to external fiat payout.

---

## 4. The ranking rule

When multiple anchors or corridors serve the same currency pair (e.g. USD → NGN),
the route planner ranks them using a deterministic hierarchy:

```text
1. Proof Tier        ─── proven  >  verified  >  unverified
2. Freshness         ─── Lower ledger staleness (more recently attested)
3. Health Score      ─── Zero consecutive breaker failures  >  lanes with prior faults
4. Economic Quality  ─── Higher net payout (destAmount) & lower fees via SEP-38 quotes
5. Latency           ─── Faster historical settlement / reconciliation turnaround
```

### Determinism invariant

The ranking rule must be **strictly deterministic**. Given the same intent,
corridor candidates, and registry state, the planner must always produce the
identical order.

Why? The engine calls `resolve()` at two points:

1. **First run:** Before the quote is requested.
2. **Resume:** When recovering or reconciling after an unexpected restart.

If the ranking rule relied on non-deterministic randomness or volatile metrics, a
resumed payment could route reconciliation to the wrong anchor, leaving the
actual settlement stranded.

---

## 5. The fallback rule

When the preferred route cannot be used, the planner applies the **Fallback Rule**:

### Core invariant: fail closed, never silently weaken trust

A fallback route must satisfy the **same or higher trust criteria** as the primary
route.

```text
[ Primary Route: Attested Anchor A ] ─── Stale / Breaker Halted?
                 │
                 ├── YES ──► [ Candidate B: Attested Anchor B ] ─── Valid?
                 │                                                   │
                 │                                                   ├── YES ──► Route to B
                 │                                                   └── NO  ──► Fail Closed (ROUTE_REFUSED)
                 │
                 └── NEVER silently fall back to an Unverified Anchor!
```

- If Candidate A was selected because it is `"attested"`, but its attestation
  expired or its breaker tripped (`CORRIDOR_HALTED`), the planner evaluates
  Candidate B.
- If Candidate B also has a valid on-chain attestation and passing breaker health,
  routing falls back to Candidate B.
- If no alternative candidate has valid attestation evidence, the planner
  **throws `UnattestedAnchorError`**. It does **not** fall back to an unverified
  manifest route. Silently degrading to an unverified lane is the exact failure
  mode the architecture is designed to prevent.

### Pre-settle lock

Fallback is strictly a **pre-settlement** mechanism. Once the engine enters
`settling` and submits an on-chain Stellar transaction, the route is permanently
locked to that anchor. A post-settlement error enters recovery (`refund_sender`,
`hold`, or reconcile polling), never an alternative route fallback.

---

## 6. The route types in plain words

`corridor-in-a-box` categorizes counterparty endpoints into three distinct
archetypes:

### 1. SEP-31 (Direct Anchor-to-Anchor)

- **What it is:** The Stellar standard designed specifically for B2B cross-border
  payments between two licensed institutions (e.g., a sending PSP and a receiving
  anchor).
- **How it works:**
  1. The sending business authenticates with the receiving anchor via SEP-10.
  2. The sender submits recipient KYC via SEP-12.
  3. The sender obtains a firm exchange rate via SEP-38 (`POST /quote`).
  4. The sender registers the transaction via SEP-31 (`POST /transactions`) and
     receives unique deposit instructions (a Stellar account and a memo).
  5. The sender executes a single native Stellar payment of the bridge asset.
  6. The sender polls `GET /transactions/:id` until the anchor completes fiat delivery.
- **Why it is preferred:** Completely non-interactive, programmatic, and built for
  unattended corporate remittances.

### 2. SEP-6 (Programmatic Deposit/Withdrawal) with the Third-Party Caveat

- **What it is:** A programmatic transfer API exposing `GET /info`, `POST /withdraw-exchange`,
  and `GET /transaction`.
- **The Third-Party Caveat:**
  SEP-6 was originally authored for **first-party retail users** interacting directly
  with an anchor (a user depositing or withdrawing their own funds). When used by
  an enterprise payment engine:
  - The remittance operator acts as a **third party** transferring funds on behalf
    of an end customer.
  - Many SEP-6 anchors require the on-chain payment to originate from a keypair
    registered to the end user, or enforce KYC flows that assume direct retail
    relationship.
  - Some SEP-6 endpoints require browser interactions or CAPTCHAs for withdrawals,
    which cannot run inside an unattended backend engine.
  - **Rule:** A SEP-6 route is runnable only if the anchor's API explicitly permits
    third-party programmatic payouts and non-interactive authentication.

### 3. Wallets (Retail / Consumer Applications)

- **What they are:** User-facing applications (e.g. Vibrant, Lobstr) that custody
  keys, display balances, and render consumer UIs.
- **Why they are NOT route destinations:**
  - A wallet is a **client** of the network, not an anchor.
  - Wallets do not expose public SEP-31 receive servers or SEP-6 transfer servers.
  - In `contracts/anchors.json`, domains like `vibrantapp.com` are cataloged with
    `kind: "other"` and explicit notes documenting that they are non-custodial
    wallet apps without receive-side infrastructure.
  - You cannot route a corridor into a wallet domain. Routing targets must be
    registered, attested anchors capable of off-ramping value into local banking
    or mobile money rails.

---

## 7. How to plug in a custom planner

Deployments are not locked into the built-in resolvers. You can plug in a custom
planner (e.g. weighted by proprietary FX spreads, latency history, or volume quotas)
**without forking the repository**.

### Step 1: Implement the RouteResolver interface

Create a TypeScript or JavaScript file exporting `apiVersion = 1` and a default
factory:

```ts
import type { RouteDecision, RouteResolver, LoadResolverCtx } from "@corridor/router";
import { ROUTE_RESOLVER_API_VERSION } from "@corridor/router";
import type { Corridor } from "@corridor/manifest";
import type { PaymentIntent } from "@corridor/types";

export const apiVersion = ROUTE_RESOLVER_API_VERSION;

interface CustomPlannerOptions {
  preferredDomains?: string[];
}

export default function createPlanner(
  ctx: LoadResolverCtx,
  options?: CustomPlannerOptions,
): RouteResolver {
  return {
    async resolve(intent: PaymentIntent, corridor: Corridor): Promise<RouteDecision> {
      // 1. Inspect intent and corridor
      const domain = corridor.dest.endpoints.home_domain;

      // 2. Custom scoring / business logic
      if (options?.preferredDomains?.includes(domain)) {
        // High-priority route
      }

      // 3. Obtain adapter via the injected factory
      const receiving = ctx.adapterFor(corridor);

      // 4. Return RouteDecision
      return {
        receiving,
        trust: "attested",
      };
    },
  };
}
```

### Step 2: Configure environment variables

Point the deployment at your module via `.env` or container configuration:

```sh
CORRIDOR_RESOLVER_MODULE="./custom-planner.ts"
CORRIDOR_RESOLVER_OPTIONS='{"preferredDomains":["cowrie.exchange"]}'
pnpm serve
```

When booting, `packages/router/src/load.ts` dynamically imports the module,
validates `apiVersion === 1`, checks that default-exported factory returns an
object with `.resolve()`, and logs the active resolver.

### Step 3: Verify with the conformance suite

To guarantee that your custom planner does not violate engine safety invariants,
run the contract test suite from `@corridor/router/testing`:

```ts
import { describe } from "vitest";
import { describeResolverContract } from "@corridor/router/testing";
import createPlanner from "./custom-planner";

describeResolverContract(
  "CustomPlanner",
  (fixtures) => createPlanner({ adapterFor: () => fixtures.adapter }, {}),
  {
    unresolvable: { outcome: "rejects" },
  },
);
```

The suite automatically asserts:

1. Every decision carries a valid receiving `AnchorAdapter`.
2. Calling `resolve()` twice with the same intent yields the identical destination.
3. Refusals fail closed by throwing (no silent fallbacks).
4. Any declared `split` weights sum exactly to 1.0.

---

## 8. Summary checklist for corridor operators

- [ ] **Check attestation:** Verify the destination anchor using `pnpm probe:anchor <domain>` and confirm it has a valid on-chain record in the registry.
- [ ] **Check protocol:** Confirm the corridor manifest sets `dest.protocol: sep31` or `sep6`, matching what the anchor serves.
- [ ] **Check third-party permissions:** If using SEP-6, verify that the anchor permits unattended third-party settlement.
- [ ] **Set breaker limits:** Configure `recovery.breaker.consecutive_failures` (default 3) to prevent burning fees on dead lanes.
- [ ] **Audit liveness:** Ensure `endpoints_verified_at` is stamped once URLs are checked against `stellar.toml`.
- [ ] **Run canaries:** Land a small transaction to earn the `proven` label before opening the lane to high-volume production traffic.
