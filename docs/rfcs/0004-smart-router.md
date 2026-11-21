# RFC 0004: Smart router

- Status: proposed
- Issue: [#619](https://github.com/corridor-in-a-box/corridor-in-a-box/issues/619), [#627](https://github.com/corridor-in-a-box/corridor-in-a-box/issues/627), [#644](https://github.com/corridor-in-a-box/corridor-in-a-box/issues/644)
- Depends on: [#178](https://github.com/corridor-in-a-box/corridor-in-a-box/issues/178), [#484](https://github.com/corridor-in-a-box/corridor-in-a-box/issues/484)

## Summary

Operators need to inspect what the planner would choose without sending money.
Currently, `corridor plan` inspects a single specified manifest (`corridor plan <file.corridor.yaml>`)
offline, while `RegistryRouteResolver` gates payments at execution time. When an operator needs
to route an amount to a target currency in a destination jurisdiction, they need a pre-flight
tool to discover, evaluate, and rank candidate corridors across the fleet.

Furthermore, businesses frequently guarantee estimated prices shown to customers.
When rates fluctuate before final anchor payout, the business absorbs the slippage and must
track the financial cost (`estimate_gap`).

In addition, SEP-6 corridors carry specific payout constraints: SEP-6 was originally built
for users withdrawing their own funds (first-party withdrawal). Paying a third party through
SEP-6 is only supported by certain anchors and cannot be detected automatically from `stellar.toml`
or SEP-6 `/info` (RFC 0004 §5). Manifests must explicitly capture whether third-party payout
is supported, alongside an audit note of who confirmed it and when.

This RFC introduces the smart router route ranking engine, the `corridor routes` CLI command,
guaranteed estimates tracking in the engine, and the `dest.third_party_payout` flag for SEP-6 corridors.

## Vocabulary

- **Route Option**: A candidate path defined by a corridor manifest that can settle into the target asset and destination jurisdiction.
- **Labels**: Standardized qualification labels (`RECOMMENDED`, `PROVEN`, `VERIFIED`, `UNVERIFIED`, `NOT_RUNNABLE`, `INELIGIBLE`, `HALTED`).
- **Reasons**: Human-readable explanations accounting for why an option is ranked, qualified, or disqualified.
- **Live Mode**: Default mode. Queries anchor endpoints for live rates, availability, and responsiveness.
- **Offline Mode (`--offline`)**: Evaluates candidate corridors using local manifests and registry evidence without making network calls.
- **Guaranteed Estimate (`guaranteeEstimates`)**: Flag indicating that the business promises the customer the shown payout amount and absorbs slippage.
- **Estimate Gap (`estimate_gap`)**: The difference between the receiving anchor's actual payout amount and the guaranteed amount.
- **Third-Party Payout (`third_party_payout`)**: Flag on SEP-6 destination manifests indicating that the anchor explicitly allows payouts to accounts not owned by the sender.

## Decision

### D1: Discovery and Matching

A corridor is candidate for a payment query `(amount, to, country)` if:

1. `dest.asset` (with or without `iso4217:` prefix) matches `to` (case-insensitive), or the destination leg of `fx.path` matches `to`.
2. `compliance.dest_jurisdiction` matches `country` (case-insensitive).

### D2: Qualification and Scoring

Candidate routes are evaluated across four dimensions:

1. **Liveness & Proof**:
   - `PROVEN`: On-chain canary settlement proof is recorded and fresh.
   - `VERIFIED`: Endpoints confirmed against published `stellar.toml`.
   - `UNVERIFIED`: Endpoints present but unconfirmed or template.
   - `NOT_RUNNABLE`: Missing required endpoints.
2. **Limits & Amount Eligibility**:
   - Amount must be between `limits.min_amount` and `limits.max_amount` if declared.
   - Unproven lanes are flagged if amount exceeds the default canary cap (10.00) or `proof.canary_max_amount`.
3. **Breaker Status**:
   - Corridors with tripped circuit breakers are marked `HALTED`.
4. **Pricing & Quotes**:
   - In Live Mode, anchors with active SEP-38 servers are queried for pricing.
   - In Offline Mode, the declared `fx.quote_source` (`sep38`, `external`, `native`) is reported.

### D3: Ranking Hierarchy

1. Viable, runnable routes within limits, ordered by trust tier (`PROVEN` > `VERIFIED` with live quote > `VERIFIED` external quote).
2. Viable routes with limits/cap warnings.
3. Unverified or template routes.
4. Ineligible or halted routes.

The top-ranked viable route receives the `RECOMMENDED` badge.

### D4: Guaranteed Estimates and Estimate Gap Tracking

When `guaranteeEstimates` is enabled (`true`), the business guarantees the estimated payout amount shown to the sender/customer and absorbs any difference resulting from rate fluctuation at settlement.

1. **Guaranteed Amount**: The destination payout amount promised to the sender (from `intent.guaranteedAmount`, `opts.guaranteedAmount`, or defaulting to `quote.destAmount.amount`).
2. **Actual Amount**: The destination amount actually delivered by the receiving anchor (from `TransactionStatus.amountOut.amount` or `OpenTransaction.amountOut.amount`).
3. **Estimate Gap Calculation**:
   $$\text{estimate\_gap} = \text{actual\_amount} - \text{guaranteed\_amount}$$
   - **Gain** ($\text{estimate\_gap} > 0$): Anchor delivered more than guaranteed; recorded as a positive decimal string (e.g. `"5.00"`).
   - **Loss** ($\text{estimate\_gap} < 0$): Anchor delivered less than guaranteed; business absorbs the shortfall; recorded as a negative decimal string (e.g. `"-5.00"`).
   - **Zero** ($\text{estimate\_gap} = 0$): Anchor delivered exactly the guaranteed amount (e.g. `"0"`).
4. **Persistence & Run Status**:
   - Stored on `StoredRun.estimateGap` (and persisted in Postgres `corridor_runs.estimate_gap`).
   - Exposed on `RunResult.estimateGap` and `RunResult.estimate_gap`.
   - Exposed in `GET /payments/:key` (run status) as `estimate_gap`.

### D5: Third-Party Payouts for SEP-6 Corridors (§5)

SEP-6 was specified primarily for first-party withdrawals (the sender withdrawing funds to their own off-chain bank account). Paying a third party through SEP-6 is only supported by certain receiving anchors, and anchor APIs provide no programmatic signal indicating whether third-party payouts are permitted.

To model this constraint:

1. **Field Definition**:
   An optional `dest.third_party_payout: true` boolean field is added to `protocol: sep6` destination manifests, along with optional audit fields `dest.third_party_payout_note`, `dest.third_party_payout_confirmed_by`, and `dest.third_party_payout_confirmed_at` recording who confirmed the capability and when.
2. **Protocol Validation**:
   - The field is valid ONLY for `protocol: sep6`.
   - Non-SEP-6 corridors (e.g. `protocol: sep31`, where third-party payouts are the baseline protocol behavior, or `custom:<id>`) MUST NOT declare `dest.third_party_payout`.
   - `packages/manifest` validates this restriction and refuses any non-SEP-6 manifest that declares `third_party_payout` with `MANIFEST_INVALID`.

### D6: CLI Interface Contract

```sh
corridor routes --amount 100 --to NGN --country NG [--offline] [--network public|testnet] [--dir <dir>] [--json]
```

- Exits 0 on successful evaluation (including when 0 routes match).
- Exits 2 on invalid or missing arguments (`--amount`, `--to`, `--country`).
- Outputs a formatted text table or clean structured JSON (`--json`).
