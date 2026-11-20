# Documentation index

This directory contains technical guides, architecture specifications, and
operational runbooks for `corridor-in-a-box`.

## Guides & Architecture

| Document                                                                        | Purpose                                                                                                                    |
| :------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------- |
| **[Route planner guide](route-planner.md)**                                     | Explaining how a route is chosen: the 6 steps, the 3 labels, ranking and fallback rules, route types, and custom planners. |
| **[RouteResolver modules](route-resolver.md)**                                  | The routing seam in code: interface contract, deploy-time module loading, and test conformance.                            |
| **[Adapters](adapters.md)**                                                     | Building and verifying anchor adapters (`AnchorAdapter`) for SEP-31, SEP-6, and bespoke APIs.                              |
| **[Operations runbook](operations.md)**                                         | Deploying, monitoring, Prometheus metrics, circuit breakers, and key rotation.                                             |
| **[Threat model](threat-model.md)**                                             | Security architecture, boundaries, assets, threat actors, and mitigations.                                                 |
| **[Key management](key-management.md)**                                         | Keeping distribution account signing seeds out of memory via KMS / HSM vaults.                                             |
| **[SEP coverage](sep-coverage.md)**                                             | Protocol scope: why the engine targets SEP-31, where SEP-6 fits, and why SEP-24 is excluded from unattended runs.          |
| **[Mainnet registry](mainnet-registry.md)**                                     | Soroban attestation registry and attester contract deployment on Stellar Mainnet.                                          |
| **[Registry metadata](registry-metadata.md)**                                   | Structured anchor metadata schema and indexing across the fleet.                                                           |
| **[Registry quorum](registry-quorum.md)**                                       | Decentralized multi-attester consensus and multisig governance.                                                            |
| **[Why not Anchor Platform?](why-not-anchor-platform.md)**                      | Architectural positioning vs. SDF's Anchor Platform reference server.                                                      |
| **[Claimable balance settlement spike](claimable-balance-settlement-spike.md)** | Technical analysis of conditional settlement via Stellar claimable balances.                                               |

## Protocol Analyses

| Document                                          | Purpose                                                                                            |
| :------------------------------------------------ | :------------------------------------------------------------------------------------------------- |
| **[SEP-24 interactive flow](protocols/sep24.md)** | Analysis of hosted interactive webviews and why they belong at the edge, not in the core run loop. |

## RFCs (Requests for Comments)

| RFC                                                      | Title                                                                    |
| :------------------------------------------------------- | :----------------------------------------------------------------------- |
| **[RFC 0001](rfcs/0001-protocol-agnostic-corridors.md)** | Protocol-agnostic corridors and adapter architecture.                    |
| **[RFC 0002](rfcs/0002-source-side-funding.md)**         | Source-side funding (prefunded, SEP-6 deposit, bespoke, SEP-24 handoff). |
| **[RFC 0003](rfcs/0003-sep24-interactive-handoff.md)**   | SEP-24 interactive handoff contract addendum.                            |
| **[RFC 0004](rfcs/0004-smart-router.md)**                | Smart router and route planner architecture specification.               |
