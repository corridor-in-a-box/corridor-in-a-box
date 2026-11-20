# RFC 0004: Smart Router & Public Lane Records

- Status: proposed
- Issue: [#643](https://github.com/corridor-in-a-box/corridor-in-a-box/issues/643)
- Depends on: [RFC 0001](0001-protocol-agnostic-corridors.md), [`docs/public-lane-records.md`](../public-lane-records.md)

## Summary

This RFC specifies the architecture for intelligent corridor routing across anchor counterparties, extending the `RouteResolver` seam to support both private bilateral routing and public on-chain lane records.

## §4b Routing and Lane Opt-In

In v1, lane checks and counterparty selections are kept private to protect commercial partner graphs. Public lane records on a public blockchain reveal which anchors partner with each other, their volumes, and terms.

To enable decentralized, automated routing where receiving anchors declare inbound corridor support without off-chain agreements, this RFC defines an opt-in model.

### Key Tenets

1. **Receiver Opt-In:** A receiving anchor must cryptographically prove domain control by signing an authorization payload with the `SIGNING_KEY` published in its `stellar.toml`.
2. **Deterministic Identifier:** Corridors are indexed on-chain by $\text{SHA256}(\text{source\_domain} \,\|\, \text{dest\_domain} \,\|\, \text{bridge\_asset} \,\|\, \text{dest\_asset})$.
3. **Revocation & Expiry:** Lane records carry bounded ledger TTLs and can be explicitly revoked by the receiver key at any time.
4. **Privacy Trade-off:** Operators can choose between public opt-in lanes and private bilateral `RouteResolver` implementations.

For the complete interface sketch, Soroban contract structures, cryptographic verification flows, and threat model analysis, see [`docs/public-lane-records.md`](../public-lane-records.md).
