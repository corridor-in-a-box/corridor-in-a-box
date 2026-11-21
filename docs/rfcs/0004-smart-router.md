# RFC 0004: Smart router

- Status: proposed
- Issue: [#619](https://github.com/corridor-in-a-box/corridor-in-a-box/issues/619), [#627](https://github.com/corridor-in-a-box/corridor-in-a-box/issues/627), [#632](https://github.com/corridor-in-a-box/corridor-in-a-box/issues/632)
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

In addition, live pre-flight probing of candidate routes requires verifying that a receiving
anchor actually accepts transactions at the SEP-31 layer. Some anchors accept the SEP-10 login
handshake but reject requests at the SEP-31 layer; calling `/sep31/info` with the acquired JWT
provides an authorised, cheap second check to ensure the lane is genuinely open.

This RFC introduces the smart router route ranking engine, the `corridor routes` CLI command,
guaranteed estimates tracking in the engine, and the two-step lane check probe (`checkLane`).

## Vocabulary

- **Route Option**: A candidate path defined by a corridor manifest that can settle into the target asset and destination jurisdiction.
- **Labels**: Standardized qualification labels (`RECOMMENDED`, `PROVEN`, `VERIFIED`, `UNVERIFIED`, `NOT_RUNNABLE`, `INELIGIBLE`, `HALTED`).
- **Reasons**: Human-readable explanations accounting for why an option is ranked, qualified, or disqualified.
- **Live Mode**: Default mode. Queries anchor endpoints for live rates, availability, and responsiveness.
- **Offline Mode (`--offline`)**: Evaluates candidate corridors using local manifests and registry evidence without making network calls.
- **Guaranteed Estimate (`guaranteeEstimates`)**: Flag indicating that the business promises the customer the shown payout amount and absorbs slippage.
- **Estimate Gap (`estimate_gap`)**: The difference between the receiving anchor's actual payout amount and the guaranteed amount.
- **Lane Check (`checkLane`)**: A two-step pre-flight verification probe for candidate SEP-31 lanes: (1) SEP-10 authentication login, and (2) authorised `GET /sep31/info` probe.

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

### D5: CLI Interface Contract

```sh
corridor routes --amount 100 --to NGN --country NG [--offline] [--network public|testnet] [--dir <dir>] [--json]
```

- Exits 0 on successful evaluation (including when 0 routes match).
- Exits 2 on invalid or missing arguments (`--amount`, `--to`, `--country`).
- Outputs a formatted text table or clean structured JSON (`--json`).

### D6: Lane Check v1: Authorised GET /sep31/info Probe

Some receiving anchors accept the initial SEP-10 login (issuing a JWT) but refuse requests at the SEP-31 layer (rejecting the JWT, returning 401/403, or disabling the receive bridge asset). Calling `/sep31/info` with the JWT is a cheap second check.

To verify that a candidate lane is operational:

1. **Step 1 — SEP-10 Login (`sep10_auth`)**:
   Authenticate with the receiving anchor's `web_auth` endpoint. Fetch challenge transaction, sign with client keypair, and obtain JWT token.
   - If Step 1 fails, probe halts immediately.
   - Result: `open: false`, `failedStep: "sep10_auth"`, with descriptive `detail`/`error`.

2. **Step 2 — Authorised GET /sep31/info Probe (`sep31_info`)**:
   Call `GET /sep31/info` using `Authorization: Bearer <token>` with the JWT obtained in Step 1.
   - Verifies response is HTTP 200.
   - Verifies `receive` list is non-empty.
   - Verifies target bridge asset (if specified) is listed in `receive` and not disabled (`enabled !== false`).
   - If Step 2 fails, result: `open: false`, `failedStep: "sep31_info"`, with descriptive `detail`/`error`.

3. **Acceptance Rule**:
   - **Open only when both steps pass**: `result.open === true` if and only if both `sep10_auth` and `sep31_info` succeed.
   - **Result says which step failed**: When `result.open === false`, `result.failedStep` (and `result.step`) is explicitly set to `"sep10_auth"` or `"sep31_info"`.
