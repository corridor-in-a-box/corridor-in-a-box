// Docs content registry. Markdown lives here as strings so the docs site is
// self-contained (no fs / loader config). Mirrors the repo's docs/ + README.

export interface Doc {
  slug: string;
  title: string;
  description: string;
  body: string;
}

export const docs: Doc[] = [
  {
    slug: "overview",
    title: "Overview",
    description: "What corridor-in-a-box is and the core idea.",
    body: `# Overview

**corridor-in-a-box** is an open, manifest-driven engine for Stellar **SEP-31**
cross-border corridors. A corridor is _configuration, not code_: the engine runs
\`quote → comply → settle → reconcile → recover\` over any standards-compliant
anchor pair, and adding a new corridor is a new \`*.corridor.yaml\` file — not a fork.

> No smart contract required. SEP-31 is off-chain orchestration of a single
> **native** Stellar payment (the settle leg).

## The three boundaries

1. **engine ↔ manifest** — the engine contains no corridor-specific strings.
   Corridor #2 is a YAML file, not a code change.
2. **engine ↔ adapters** — the engine knows only the \`AnchorAdapter\` interface;
   every standards-compliant anchor shares one adapter.
3. **router seam** — the open repo ships a \`RouteResolver\` interface plus two
   resolvers: \`StaticRouteResolver\` (trust the manifest) and
   \`RegistryRouteResolver\` (require a fresh on-chain attestation). A
   health-/rate-weighted resolver could be supplied as a separate proprietary
   component, but none is included or injected today. The interface is an
   extension seam, not evidence that such a component exists.
`,
  },
  {
    slug: "getting-started",
    title: "Getting started",
    description: "Install, typecheck, test, and run a payment end-to-end.",
    body: `# Getting started

\`\`\`bash
corepack enable && pnpm install
pnpm lint        # eslint + prettier
pnpm typecheck   # whole monorepo, one tsc pass
pnpm test        # vitest: engine, manifest, money, sep31, stellar, service
pnpm example     # run a payment end-to-end (mocked anchor + settle)
pnpm cli plan corridors/reference.corridor.yaml   # offline liveness check
\`\`\`

\`pnpm example\` walks a payment through every state and proves idempotency:

\`\`\`
created -> quoted -> compliant -> opened -> verifying -> settling -> settled -> reconciled -> completed
replay with same key -> idempotent return (state=completed)
\`\`\`

## This web app

\`\`\`bash
cd web
pnpm install
pnpm dev   # http://localhost:3000
\`\`\`

The **Run a payment** page drives a simulation of the engine's state machine (a
re-implementation; it can drift). Set \`CORRIDOR_SERVICE_URL\` to drive a real
\`@corridor/service\`.
`,
  },
  {
    slug: "architecture",
    title: "Architecture",
    description: "The packages and how a payment flows through them.",
    body: `# Architecture

\`\`\`
packages/
  types/         Outcome<T> result type + decimal-safe Money
  manifest/      Zod schema for a corridor + loader
  adapter-kit/   AnchorAdapter port + conformance probes + mock adapter
  sep31/         ONE generic adapter (SEP-10 auth + SEP-12 KYC)
  sep6/          ONE generic adapter for SEP-6 anchors (GET /info discovery,
                 withdraw-exchange to open, GET /transaction to reconcile)
  stellar/       the only money-path package that touches the chain:
                 settlement submitter + SEP-10 signer
  router/        RouteResolver seam — open interface + Static and Registry resolvers
  engine/        orchestration: state machine, crash-resume, recovery, audit, metrics
  service/       thin HTTP API over the engine (auth + rate limiting, OpenAPI spec)
  otel/          OpenTelemetry adapters for the engine's Metrics and Logger
  cli/           validate a manifest; print an offline runnability plan
  probe/         probe an anchor's SEP conformance from its stellar.toml
  registry/      read conformance attestations from the on-chain registry
  attester/      submit probe results to the registry via the attester contract
contracts/       Soroban registry + attester contracts
\`\`\`

\`stellar/\` is the only package on the money path that touches the chain.
\`probe/\`, \`registry/\` and \`attester/\` read and write the conformance
registry; they never move funds.

## The five verbs

| Step | Verb | Standard |
|---|---|---|
| 1 | quote | SEP-38 \`POST /quote\` |
| 2 | comply | SEP-10 auth + SEP-12 KYC handoff |
| 3 | open | SEP-31 \`POST /transactions\` |
| 4 | settle | native Stellar payment of the bridge asset |
| 5 | reconcile | SEP-31 \`GET /transactions/:id\` |

## The state machine

A persisted state machine drives \`created → quoted → compliant → opened →
verifying → settling → settled → reconciled → completed\`. Every transition is logged,
audited, and counted. The full table, from \`packages/engine/src/state.ts\`:

| State | Possible next states |
|---|---|
| \`created\` | \`quoted\`, \`failed\` |
| \`quoted\` | \`compliant\`, \`recovering\`, \`failed\` |
| \`compliant\` | \`opened\`, \`recovering\`, \`failed\` |
| \`opened\` | \`verifying\`, \`recovering\`, \`failed\` |
| \`verifying\` | \`settling\`, \`failed\` |
| \`settling\` | \`settled\`, \`retrying\`, \`recovering\`, \`failed\` |
| \`retrying\` | \`verifying\`, \`recovering\`, \`failed\` |
| \`settled\` | \`reconciled\`, \`recovering\`, \`failed\` |
| \`reconciled\` | \`completed\`, \`failed\` |
| \`recovering\` | \`refund_pending\`, \`refunded\`, \`held\`, \`failed\` |
| \`refund_pending\` | \`refunded\`, \`held\`, \`failed\` |
| \`completed\` | terminal |
| \`refunded\` | terminal |
| \`held\` | terminal |
| \`failed\` | terminal |

\`retrying\` is entered only when a settle attempt failed before money moved,
and is the only state that may re-enter \`verifying\`. \`recovering\` and
\`refund_pending\` can be entered after settlement, so neither can reach
\`settling\` — a double-spend is unreachable by construction.
`,
  },
  {
    slug: "http-api",
    title: "HTTP API",
    description: "The @corridor/service endpoints.",
    body: `# HTTP API

\`@corridor/service\` turns the engine library into a service (zero runtime deps,
Node \`http\`).

## \`POST /payments\`

Body is a \`PaymentIntent\`:

\`\`\`json
{
  "idempotencyKey": "demo-0001",
  "corridorId": "mx-example",
  "sender": { "id": "sender-1" },
  "recipient": { "id": "recipient-1" },
  "sourceAmount": { "asset": "USDC", "amount": "100.00" }
}
\`\`\`

## Status code mapping

| Status | Error / Condition | Description |
|---|---|---|
| \`200\` | — | Payment completed successfully, run state returned, health check ok, or metrics rendered |
| \`400\` | \`invalid payment body\`, \`invalid JSON\` | Malformed JSON or invalid \`PaymentIntent\` body structure |
| \`401\` | \`unauthorized\` | Missing or invalid Bearer API key |
| \`403\` | \`KYC_REJECTED\` | Receiving anchor rejected customer KYC |
| \`403\` | \`PRESETTLE_RECEIVER_NOT_ACCEPTED\` | The recipient's SEP-12 status is no longer ACCEPTED at the pre-settle gate; nothing was sent |
| \`404\` | \`unknown corridor\`, \`not found\` | Unknown corridor ID, run key not found (or foreign tenant key), or unmatched route |
| \`409\` | \`IDEMPOTENCY_CONFLICT\` | Replay with conflicting parameters or in-flight payment with same key |
| \`409\` | \`QUOTE_EXPIRED\` | Anchor quote expired before settlement could begin |
| \`409\` | \`KYC_REQUIRED\` | Customer KYC incomplete or customer action required |
| \`409\` | \`PRESETTLE_TX_MISMATCH\` | The transaction the anchor opened is not what the engine was about to pay (amount, deposit account or memo); nothing was sent |
| \`409\` | \`PRESETTLE_QUOTE_WINDOW\` | The firm quote would not survive settle and confirm; nothing was sent |
| \`409\` | \`MANIFEST_CHANGED\` | Corridor manifest changed since the run started; resume refused before settle |
| \`409\` | \`DRY_RUN_COMPLETE\` | A \`dryRun: true\` run passed the pre-settle gate and stopped before settling; nothing was sent. The HTTP API never starts dry runs, so this code only appears from the engine or CLI |
| \`413\` | \`payload too large\` | Request body exceeds \`maxBodyBytes\` cap (default 64 KiB) |
| \`422\` | \`AMOUNT_INVALID\` | Amount is not a positive decimal or cannot be settled |
| \`422\` | \`CAPABILITY_MISMATCH\` | Adapter capabilities do not match corridor manifest or settlement strategies |
| \`422\` | \`MANIFEST_INVALID\` | Corridor manifest validation failed |
| \`422\` | \`PRESETTLE_DESTINATION_UNSAFE\` | Destination account missing, without a trustline, or not authorized; nothing was sent |
| \`422\` | \`PRESETTLE_INSUFFICIENT_FUNDS\` | The signer's balance cannot cover amount, fee and reserve; nothing was sent |
| \`422\` | \`PRESETTLE_AMOUNT_OUT_OF_RANGE\` | Amount is outside the anchor's or manifest's min/max; nothing was sent |
| \`422\` | \`CORRIDOR_UNPROVEN\` | Amount is above the canary cap on a lane that is not yet \`PROVEN\` |
| \`429\` | \`rate_limited\` | Token-bucket rate limit exceeded for client IP or API key |
| \`500\` | \`SETTLEMENT_FAILED\` | On-chain Stellar payment transaction failed |
| \`500\` | \`RECONCILE_MISMATCH\` | Settled amounts or assets do not match anchor transaction record |
| \`500\` | \`internal\` | Unexpected server error or unhandled failure fallback |
| \`501\` | \`REFUND_UNSUPPORTED\` | Payment failed and anchor does not support refund |
| \`502\` | \`QUOTE_UNAVAILABLE\` | Origin or destination anchor failed to provide a quote |
| \`502\` | \`PRESETTLE_ANCHOR_DRIFT\` | The anchor's live \`/info\` or stellar.toml no longer matches what was verified; nothing was sent |
| \`502\` | \`ANCHOR_UNAVAILABLE\` | Upstream anchor service unreachable or returned an upstream error |
| \`503\` | \`CORRIDOR_HALTED\` | Circuit breaker is open for this corridor: too many consecutive lane failures. No run was created and nothing was sent to the anchor. Retry is pointless until the lane is reset — see \`docs/operations.md\` §7. Non-retryable |
| \`503\` | \`ROUTE_REFUSED\` | The resolver would not route the payment (for example an unattested anchor). Well-formed request, no trusted route available |
| \`503\` | \`draining\` | The service is shutting down and is refusing new payments |
| \`504\` | \`SETTLEMENT_TIMEOUT\` | Stellar network submission timed out |
| \`504\` | \`RECONCILE_STALLED\` | Anchor transaction polling timed out |

## Other endpoints

- \`GET /payments/:key\` — current run state (scoped to authenticated tenant).
- \`GET /healthz\` — liveness (public, unmetered).
- \`GET /readyz\` — readiness: 200 when every check passes, 503 while draining or when one fails (public, unmetered).
- \`POST /callbacks/sep31/:corridorId\` — the receiving anchor's signed callback; wakes the reconcile loop for that transaction.
- \`GET /metrics\` — Prometheus text exposition format (public, unmetered; served when \`metricsText\` is configured).

Optional bearer **API-key** auth and an in-memory **token-bucket** rate limiter
are configured on the service context. For more than one replica, inject
\`RedisTokenBucket\` so the limit holds fleet-wide. The full contract, with every
request and response shape, is \`packages/service/openapi.yaml\` (OpenAPI 3.1).
`,
  },
  {
    slug: "key-management",
    title: "Key management",
    description: "Keeping the signing key out of the application process.",
    body: `# Signing-key management

The distribution account's seed is the most sensitive thing in a deployment.
All key access is isolated behind one port so the seed never has to live in the
application process.

\`\`\`ts
interface ExternalSigner {
  readonly publicKey: string; // G…
  sign(data: Uint8Array): Promise<Uint8Array>; // ed25519 over the tx hash
}
\`\`\`

| Environment | Signer | Where the seed lives |
|---|---|---|
| Local / testnet | \`LocalKeypairSigner\` | In process — throwaway testnet keys only |
| **Production** | A KMS/HSM-backed \`ExternalSigner\` | In the vault; never in the app |

A KMS/HSM that supports ed25519 implements \`ExternalSigner\` by delegating
\`sign\` to the vault, so the application only ever sees the public key and a
finished signature. Rotate keys on a schedule; because callers depend on the
port, rotation is a config change, not a code change. Shipped implementations:
\`VaultTransitSigner\` (HashiCorp Vault Transit), \`AwsKmsSigner\` and \`GcpKmsSigner\`.
`,
  },
  {
    slug: "why-not-anchor-platform",
    title: "Why not Anchor Platform?",
    description: "How this relates to the SDF Anchor Platform.",
    body: `# Why not just use the Anchor Platform?

The Anchor Platform is the **server an anchor runs** to _expose_ SEP endpoints.
\`corridor-in-a-box\` is the **orchestrator an operator runs** to _drive a payment
across two anchors_ and move the on-chain bridge asset between them. They are
complementary — in a real lane the receiving anchor runs the Anchor Platform and
this engine talks to it.

| Aspect | Anchor Platform | corridor-in-a-box |
|---|---|---|
| Who runs it | An anchor | A remittance operator / PSP |
| Role | Serve SEP endpoints | Orchestrate a payment end-to-end |
| Owns the settle leg | No | Yes (native Stellar payment) |
| Multi-anchor routing | No | Seam only (\`RouteResolver\`); no multi-anchor resolver ships yet |
| Idempotency / recovery | N/A | Core |
`,
  },
  {
    slug: "onboarding",
    title: "Onboarding guide",
    description: "Onboarding guide for sending businesses, receiver checks, and compliance responsibilities.",
    body: `# Onboarding Guide for Sending Businesses

This document explains how sending businesses onboard with receiving anchors, how lane readiness is verified, and where legal responsibilities lie.

## Role of corridor-in-a-box

\`corridor-in-a-box\` is an open-source technical orchestration engine for cross-border payment corridors over Stellar. It coordinates the five canonical payment verbs across standards-compliant anchors:

\`quote → comply → settle → reconcile → recover\`

The software is not a bank, custodian, or money transmitter. It does not hold funds, provide liquidity, or provide legal authorization to transfer funds.

## What a Receiver Checks

Receiving anchors are licensed financial institutions or money service businesses in destination jurisdictions. When establishing a commercial lane, a receiving anchor typically evaluates:

1. **Entity Verification & KYB**: Certificate of incorporation, registered address, good standing, and identification of Ultimate Beneficial Owners (UBOs).
2. **AML/CFT Controls**: Sanctions screening policies, source-of-funds verification, and transaction monitoring controls.
3. **Corridor Profile & Projected Volumes**: Expected payment volumes, currencies, and destination payout channels.

## The Company Profile and Customer Data (SEP-12)

Sending businesses provide customer compliance details to destination anchors using Stellar's **SEP-12** specification. In SEP-31 cross-border corridors:

- **Sender Profile (\`sep31-sender\`)**: Legal company name, registration number, registered jurisdiction, tax ID, and authorized representative details.
- **Receiver Profile (\`sep31-receiver\`)**: Recipient legal name, destination bank/sort code, account number or mobile money wallet identifier.

## Lane Checks & Pre-Flight Verification

Before routing production volume, sending businesses verify lane health:

1. **Structural Manifest Validation**: Run \`corridor plan <corridor.yaml>\` to inspect the execution pipeline and verify destination endpoints.
2. **On-Chain Attestation**: Verify fresh attestations on the Soroban registry using \`pnpm registry:read\`.
3. **Pre-Settle Safety Gate**: Automated safety checks verify that the anchor accepted the transfer before funds move on chain.
4. **Circuit Breakers**: Consecutive failures trigger the health store breaker (\`CORRIDOR_HALTED\`), halting traffic during anchor outages.

## Legal and Regulatory Responsibility

The sending business remains strictly responsible for holding required money transmitter licenses, providing statutory consumer disclosures, performing sanctions/AML screenings, executing bilateral commercial contracts with receivers, and managing settlement risk.
`,
  },
  {
    slug: "glossary",
    title: "Glossary",
    description: "Plain, one-sentence definitions of key terms for non-engineers.",
    body: `# Glossary

Plain, one-sentence definitions of key terms used across \`corridor-in-a-box\` and Stellar cross-border payments.

## Core Concepts

- **Anchor**: A licensed financial entity or gateway that bridges off-chain banking systems and the on-chain Stellar network.
- **Corridor (or Lane)**: A configured payment route between a source currency/jurisdiction and a destination currency/jurisdiction operated by specific anchors.
- **Manifest**: A YAML file defining a corridor's endpoints, assets, compliance methods, and settlement rules without requiring code changes.
- **Bridge Asset**: An on-chain digital currency (such as USDC) used as an intermediate settlement asset between the sending anchor and receiving anchor.
- **Settle Leg**: The native Stellar transaction that transfers the bridge asset from the sender's account to the receiving anchor's deposit address.
- **Reconciliation**: The automated process where the engine polls the receiving anchor until the final fiat payout is confirmed completed.
- **Idempotency**: A safety guarantee ensuring that retrying a payment request with the same idempotency key never creates duplicate payouts or double spends.
- **Circuit Breaker**: An automated safety mechanism that halts new payments on a failing corridor after consecutive anchor errors.
- **Registry**: An on-chain Soroban contract that stores tamper-evident, verifiable conformance facts and probe history for anchors.
- **Attestation**: A signed, timestamped record on the Soroban registry proving that an anchor was tested and verified against Stellar standards.

## Standards & Protocols

- **SEP (Stellar Ecosystem Proposal)**: A public, community-governed technical standard specifying interoperability rules on Stellar.
- **SEP-1**: The standard defining \`stellar.toml\`, a discovery file hosted at \`/.well-known/stellar.toml\` describing an anchor's published capabilities and endpoints.
- **SEP-6**: A protocol for deposit and withdrawal where an anchor handles asset transfers directly through programmatic API requests.
- **SEP-10**: A cryptographic challenge-response authentication standard using Stellar keypairs to issue JSON Web Tokens (JWTs) for API access.
- **SEP-12**: A standardized KYC protocol allowing anchors to collect customer identification and compliance data programmatically.
- **SEP-24**: An interactive deposit and withdrawal standard where an anchor presents a hosted web view to the user for compliance and payout details.
- **SEP-31**: The cross-border remittance protocol enabling direct, business-to-business payments between sending and receiving financial institutions.
- **SEP-38**: The Anchor RFQ (Request for Quote) standard for querying indicative prices and locking firm exchange rates between assets.

## Routing & Quotation

- **RouteResolver**: The pluggable routing interface that selects the appropriate destination anchor and execution parameters for a payment intent.
- **RoutePlanner**: The component that evaluates available corridors, filters out inactive or non-compliant options, and presents ranked choices.
- **Locked Price**: A guaranteed exchange rate backed by a firm SEP-38 quote with a fixed expiration window (\`expiresAt\`).
- **Indicative Price**: A prevailing market exchange rate queried from an anchor's live price feed when a firm guaranteed quote is unavailable.
- **Estimated Price**: A fallback price projection calculated from historical rates when an anchor publishes neither firm quotes nor a live price feed.
- **Pre-Settle Gate**: A mandatory verification check performed immediately before broadcasting on-chain funds to confirm anchor acceptance.
`,
  },
];

export function getDoc(slug: string): Doc | undefined {
  return docs.find((d) => d.slug === slug);
}
