# Public On-Chain Lane Records (Receiver Opt-In)

**Status:** Design Spike (RFC 0004 §4b follow-up)  
**Target:** Soroban on Stellar  
**Security Reference:** [`docs/threat-model.md`](threat-model.md)

---

## 1. Context and Problem Statement

In `corridor-in-a-box`, routing currently operates through `@corridor/router` using either static manifests or the on-chain registry (`RegistryRouteResolver`). While the on-chain registry (`contracts/registry`) validates individual anchor conformance (SEPs supported, endpoints responding, probe pass rates), it does **not** store bilateral corridor agreements—that is, which sending anchors are authorized to settle into which receiving anchors.

RFC 0004 §4b intentionally deferred public on-chain lane records for v1:

> _"Public lane records reveal commercial relationships and partner graphs on a public ledger. V1 keeps lane authorization private between counterparties and leaves public lane records for an explicit opt-in design."_

Without on-chain lane records, sending anchors rely on local manifests or out-of-band agreements. However, establishing decentralized, automated routing requires receiving anchors to formally **opt in** and declare which corridors they actively support, their allowed settlement assets, and operational limits.

This design note specifies:

1. The **contract shape** and data structures for an opt-in lane registry.
2. How a receiver **proves control** of its domain's cryptographic signing key.
3. **Revocation** and lifecycle management.
4. The **privacy trade-off** between public verifiability and counterparty confidentiality.
5. A review against the system **threat model** ([`docs/threat-model.md`](threat-model.md)).

---

## 2. Contract Architecture & Interface Sketch

The Lane Registry is implemented as an opt-in Soroban smart contract (`contracts/lane-registry`) operating alongside `contracts/registry`.

### 2.1 Data Structures

```rust
#[derive(Clone, PartialEq, Eq)]
#[contracttype]
pub struct LaneId(pub BytesN<32>);

#[derive(Clone)]
#[contracttype]
pub struct LaneLimits {
    pub min_amount: i128,       // scaled with asset decimal precision (10^7)
    pub max_amount: i128,
}

#[derive(Clone, Copy, PartialEq, Eq)]
#[contracttype]
pub enum LaneStatus {
    Active = 1,
    Suspended = 2,
    Revoked = 3,
}

#[derive(Clone)]
#[contracttype]
pub struct LaneRecord {
    pub lane_id: LaneId,
    pub source_domain: String,     // Sending anchor domain
    pub dest_domain: String,       // Receiving anchor domain
    pub bridge_asset: Address,     // Stellar Asset Contract (SAC) address (e.g. USDC)
    pub dest_asset: Symbol,        // Destination off-chain or on-chain asset (e.g. USD, NGN)
    pub receiver_key: BytesN<32>,  // ed25519 public key published in receiver's stellar.toml
    pub limits: Option<LaneLimits>,
    pub registered_ledger: u32,
    pub expires_ledger: u32,
    pub status: LaneStatus,
}

#[derive(Clone)]
#[contracttype]
pub struct ReceiverAuthProof {
    pub signature: BytesN<64>,     // ed25519 signature over authorization payload
    pub nonce: u64,
    pub expires_ledger: u32,
}
```

### 2.2 Interface Sketch

```rust
pub trait LaneRegistryTrait {
    /// Register an authorized corridor lane.
    /// Requires ed25519 signature from the receiver's attested signing key.
    fn register_lane(
        env: Env,
        proof: ReceiverAuthProof,
        source_domain: String,
        dest_domain: String,
        bridge_asset: Address,
        dest_asset: Symbol,
        limits: Option<LaneLimits>,
    ) -> LaneId;

    /// Revoke an existing corridor lane immediately.
    /// Must be invoked by the receiver key (or authorized admin emergency pause).
    fn revoke_lane(env: Env, lane_id: LaneId, signature: BytesN<64>) -> Result<(), Error>;

    /// Suspend or resume lane operations (e.g. for maintenance or temporary rebalancing).
    fn set_lane_status(env: Env, lane_id: LaneId, status: LaneStatus, signature: BytesN<64>) -> Result<(), Error>;

    /// Read an active lane record by its deterministic identifier.
    fn get_lane(env: Env, lane_id: LaneId) -> Option<LaneRecord>;

    /// Fast lookup to check if a specific route is opted-in, active, and within limits.
    fn is_lane_routable(
        env: Env,
        source_domain: String,
        dest_domain: String,
        bridge_asset: Address,
        dest_asset: Symbol,
        amount: i128,
    ) -> bool;
}
```

### 2.3 Deterministic Lane Identification

Lanes are uniquely identified by hashing the canonical tuple:
$$\text{LaneId} = \text{SHA256}(\text{source\_domain} \,\|\, \text{dest\_domain} \,\|\, \text{bridge\_asset} \,\|\, \text{dest\_asset})$$

This guarantees that a given directional corridor has at most one active authorization entry, preventing conflicting records.

---

## 3. Cryptographic Proof of Domain Control

A critical security invariant is that **only the receiving anchor** can register or authorize incoming corridors to its domain. A malicious sender must not be able to publish unauthorized lane records claiming a partnership with an anchor.

### 3.1 Trust Chain to `stellar.toml`

1. **Attested Domain Key:** The existing registry contract (`contracts/registry`) attests anchor conformance and stores the hash of the anchor's `stellar.toml`. The attestation verifies that `dest_domain` publishes a valid `SIGNING_KEY` (ed25519 public key).
2. **Authorized Payload Construction:**
   To opt in to a lane, the receiving anchor signs an explicit off-chain payload structured as:
   ```
   "CORRIDOR_LANE_OPTIN" || network_passphrase || contract_address || lane_id || nonce || expires_ledger
   ```
3. **On-Chain Verification:**
   When `register_lane` is called:
   - The contract computes the expected `lane_id`.
   - The contract queries `contracts/registry` to verify that `dest_domain` is attested and active.
   - The contract verifies `proof.signature` against the attested `receiver_key` using Soroban's native `env.crypto().ed25519_verify()`.
   - The contract checks that `nonce` has not been consumed and `env.ledger().sequence() <= proof.expires_ledger`.

This ensures mathematical proof of receiver consent without requiring the receiver to submit transactions directly or hold testnet/mainnet XLM (the transaction submission can be sponsored or submitted by the sending anchor).

---

## 4. Revocation and Lifecycle Management

A lane record must be revokable quickly if an anchor partnership terminates, liquidity fails, or compliance conditions change.

1. **Explicit Self-Revocation:**
   The receiver signs a `revoke_lane` command targeting `lane_id`. Once processed, `status` advances to `LaneStatus::Revoked`. Revoked records fail closed in `is_lane_routable`.
2. **Time-To-Live (TTL) Leases:**
   Lane registrations are leased for a bounded duration (e.g. 100,000 ledgers, ~5–6 days). Corridors must be renewed periodically by submitting a refreshed authorization proof. If a receiver ceases renewals, the lane automatically expires, preventing abandoned lanes from persisting indefinitely.
3. **Emergency Circuit Breaking:**
   An authorized contract governor / multisig retain emergency suspension capability to freeze lanes if anomalous fraudulent flows or contract vulnerabilities are identified.

---

## 5. Privacy Trade-Off Analysis

Public blockchain registries introduce significant privacy trade-offs that every operator and ecosystem participant must balance:

| Model                                     | Advantages                                                                                                                                                                             | Disadvantages & Risks                                                                                                                                           |
| :---------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fully Public Plaintext Lanes**          | Zero coordination overhead; global discoverability; router selects best attested routes without private secrets.                                                                       | **Counterparty Graph Exposure:** Competitors and surveillance firms can map entire business relationships, partner networks, corridors, and operational limits. |
| **Hashed Identifier Scheme**              | Hides plaintext domains: $\text{LaneHash} = H(\text{source} \,\|\, \text{dest} \,\|\, \text{salt})$. Only counterparties who already know each other can compute and look up the lane. | Cannot be browsed or discovered by third-party searchers; requires out-of-band salt distribution.                                                               |
| **Zero-Knowledge Route Credentials (ZK)** | Receiver issues a cryptographic commitment/signature to sender; sender proves route validity in ZK during settlement without revealing the receiver identity until necessary.          | High compute overhead; complex proving infrastructure for anchors; unnecessary for standard public remittance rails.                                            |

### Recommendation

Adopt a **dual-mode routing model**:

- **Public Lanes (Opt-In):** Plaintext records for public-benefit remittance corridors, sovereign financial inclusion corridors, and open-market stablecoin liquidity routes where transparency builds consumer trust.
- **Private Fallback:** B2B commercial institutions that require partner confidentiality continue to utilize private `RouteResolver` implementations (as documented in [`docs/route-resolver.md`](route-resolver.md)) without publishing lane associations on-chain.

---

## 6. Threat Model Review (`docs/threat-model.md`)

This design is reviewed against the four core asset classes and trust boundaries defined in [`docs/threat-model.md`](threat-model.md):

1. **Asset 1.1 (Signing Key Isolation):**
   The receiver's signing key is never transferred or exposed. Only ed25519 signatures over strict, domain-separated payloads are verified.
2. **Asset 1.2 (Funds in Flight):**
   Pre-settle gates query `is_lane_routable`. If a receiver revokes a lane while a payment is in flight, the pre-settle gate halts execution before settlement submission, preventing uncollectable deposits.
3. **Asset 1.4 (Registry Integrity):**
   Lane registrations are cryptographically bound to the attested `stellar.toml` signing key. Spoofed domain claims are rejected.
4. **Boundary 3.4 (Attester / Registry Contract Boundary):**
   Nonce tracking defeats signature replay attacks across chains or ledgers. Bounded TTLs prevent state bloating on the Soroban network.
