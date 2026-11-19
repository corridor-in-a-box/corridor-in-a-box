# Glossary

Plain, one-sentence definitions of key terms used across `corridor-in-a-box` and Stellar cross-border payments.

---

### Core Concepts

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

---

### Standards & Protocols

- **SEP (Stellar Ecosystem Proposal)**: A public, community-governed technical standard specifying interoperability rules on Stellar.
- **SEP-1**: The standard defining `stellar.toml`, a discovery file hosted at `/.well-known/stellar.toml` describing an anchor's published capabilities and endpoints.
- **SEP-6**: A protocol for deposit and withdrawal where an anchor handles asset transfers directly through programmatic API requests.
- **SEP-10**: A cryptographic challenge-response authentication standard using Stellar keypairs to issue JSON Web Tokens (JWTs) for API access.
- **SEP-12**: A standardized KYC protocol allowing anchors to collect customer identification and compliance data programmatically.
- **SEP-24**: An interactive deposit and withdrawal standard where an anchor presents a hosted web view to the user for compliance and payout details.
- **SEP-31**: The cross-border remittance protocol enabling direct, business-to-business payments between sending and receiving financial institutions.
- **SEP-38**: The Anchor RFQ (Request for Quote) standard for querying indicative prices and locking firm exchange rates between assets.

---

### Routing & Quotation

- **RouteResolver**: The pluggable routing interface that selects the appropriate destination anchor and execution parameters for a payment intent.
- **RoutePlanner**: The component that evaluates available corridors, filters out inactive or non-compliant options, and presents ranked choices.
- **Locked Price**: A guaranteed exchange rate backed by a firm SEP-38 quote with a fixed expiration window (`expiresAt`).
- **Indicative Price**: A prevailing market exchange rate queried from an anchor's live price feed when a firm guaranteed quote is unavailable.
- **Estimated Price**: A fallback price projection calculated from historical rates when an anchor publishes neither firm quotes nor a live price feed.
- **Pre-Settle Gate**: A mandatory verification check performed immediately before broadcasting on-chain funds to confirm anchor acceptance.
