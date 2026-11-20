# RFC 0004: Smart router

- Status: proposed
- Issue: [#619](https://github.com/corridor-in-a-box/corridor-in-a-box/issues/619)
- Depends on: [#178](https://github.com/corridor-in-a-box/corridor-in-a-box/issues/178), [#484](https://github.com/corridor-in-a-box/corridor-in-a-box/issues/484)

## Summary

Operators need to inspect what the planner would choose without sending money.
Currently, `corridor plan` inspects a single specified manifest (`corridor plan <file.corridor.yaml>`)
offline, while `RegistryRouteResolver` gates payments at execution time. When an operator needs
to route an amount to a target currency in a destination jurisdiction, they need a pre-flight
tool to discover, evaluate, and rank candidate corridors across the fleet.

This RFC introduces the smart router route ranking engine and the `corridor routes` CLI command:
`corridor routes --amount <amount> --to <asset> --country <country> [--offline] [--network <public|testnet>] [--dir <dir>] [--json]`.

## Vocabulary

- **Route Option**: A candidate path defined by a corridor manifest that can settle into the target asset and destination jurisdiction.
- **Labels**: Standardized qualification labels (`RECOMMENDED`, `PROVEN`, `VERIFIED`, `UNVERIFIED`, `NOT_RUNNABLE`, `INELIGIBLE`, `HALTED`).
- **Reasons**: Human-readable explanations accounting for why an option is ranked, qualified, or disqualified (e.g. endpoint verification dates, canary proof presence, limit bounds, quote source, anchor reachability).
- **Live Mode**: Default mode. Queries anchor endpoints (such as `stellar.toml` and SEP-38 quote servers) for live rates, availability, and responsiveness.
- **Offline Mode (`--offline`)**: Evaluates candidate corridors using local manifests and registry evidence without making network calls to anchors.

## Decision

### 1. Discovery and Matching

A corridor is candidate for a payment query `(amount, to, country)` if:

1. `dest.asset` (with or without `iso4217:` prefix) matches `to` (case-insensitive), or the destination leg of `fx.path` matches `to`.
2. `compliance.dest_jurisdiction` matches `country` (case-insensitive).

### 2. Qualification and Scoring

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

### 3. Ranking Hierarchy

1. Viable, runnable routes within limits, ordered by trust tier (`PROVEN` > `VERIFIED` with live quote > `VERIFIED` external quote).
2. Viable routes with limits/cap warnings.
3. Unverified or template routes.
4. Ineligible or halted routes.

The top-ranked viable route receives the `RECOMMENDED` badge.

### 4. CLI Interface

```sh
corridor routes --amount 100 --to NGN --country NG [--offline] [--network public|testnet] [--dir <dir>] [--json]
```

- Exits 0 on successful evaluation (including when 0 routes match).
- Exits 2 on invalid or missing arguments (`--amount`, `--to`, `--country`).
- Outputs a formatted text table or clean structured JSON (`--json`).
