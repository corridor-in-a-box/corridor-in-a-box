# Onboarding Guide for Sending Businesses

This document explains how a sending business (remittance operator, payment service provider, or corporate sender) onboard with receiving anchors using `corridor-in-a-box`, how lane readiness is checked, and where the boundaries of technical orchestration and legal responsibility lie.

---

## 1. Role of corridor-in-a-box

`corridor-in-a-box` is an open-source technical orchestration engine for cross-border payment corridors over Stellar. It coordinates the five canonical payment verbs across standards-compliant anchors:

$$\text{quote} \longrightarrow \text{comply} \longrightarrow \text{settle} \longrightarrow \text{reconcile} \longrightarrow \text{recover}$$

- **What the software does**: Orchestrates SEP-10 authentication, SEP-12 customer data collection, SEP-38 quotation, SEP-31/SEP-6 transfer submission, native Stellar bridge-asset settlement, transaction reconciliation, and crash recovery.
- **What the software does not do**: The software is **not a bank, custodian, or money transmitter**. It does not hold funds, provide liquidity, or provide legal/regulatory authorization to transfer funds.

---

## 2. What a Receiver Checks

Receiving anchors are licensed financial institutions or money service businesses in destination jurisdictions (e.g., Cowrie in Nigeria, Zeam in South Africa). When establishing a commercial lane, a receiving anchor typically evaluates:

1. **Entity Verification & KYB (Know Your Business)**:
   - Certificate of incorporation, registered address, and good standing certificates.
   - Ownership structure and identification of Ultimate Beneficial Owners (UBOs) holding $\ge 25\%$ equity.
   - Proof of active regulatory registrations or money transmitter licenses in origin jurisdictions.
2. **AML/CFT Controls & Compliance Policies**:
   - Sanctions screening policies (OFAC, UN, local sanctions lists).
   - Source-of-funds verification and transaction monitoring controls.
   - Customer onboarding tiers and KYC standards matching the receiver's local requirements.
3. **Corridor Profile & Projected Volumes**:
   - Expected monthly payment volumes and average transaction sizes.
   - Currencies involved (origin asset, bridge asset like USDC, and destination fiat).
   - Expected settlement mechanisms and payout channels (e.g., local bank rails, mobile money).

---

## 3. The Company Profile and Customer Data (SEP-12)

Sending businesses provide customer compliance details to destination anchors using Stellar's **SEP-12** specification. In SEP-31 cross-border corridors:

- **Sender Profile (`sep31-sender`)**:
  - For businesses: legal company name, registration number, registered jurisdiction, tax ID, and authorized representative details.
  - For individuals: full legal name, date of birth, residential address, government ID number, and proof of address.
- **Receiver Profile (`sep31-receiver`)**:
  - Recipient full legal name, destination bank code/sort code, account number or mobile money wallet identifier, and routing details.
- **Dynamic Field Requirements**:
  - The anchor defines the required and optional fields through its `GET /customer` endpoint. `corridor-in-a-box` queries these requirements dynamically during the `comply` verb and validates payloads prior to submission.

---

## 4. Exporters and Technical Integration

Sending businesses integrate their existing accounting, ERP, or payment initiation platforms with `corridor-in-a-box`:

- **HTTP Service API**: The `@corridor/service` package provides an authenticated, rate-limited HTTP server exposing `POST /payments`, `GET /payments/:id`, and `/readyz` health endpoints conforming to OpenAPI 3.1.
- **CLI Workflow**: Operators can run dry-runs and automated verification using `corridor plan` and `corridor canary`.
- **Database & Idempotency Store**: Payments are secured with durable Postgres idempotency keys (`idempotency_key`), preventing duplicate payouts during network interruptions or worker restarts.
- **Key Management**: Signing secrets for on-chain settlement are managed via hardware security modules or cloud KMS providers (`AwsKmsSigner`, `GcpKmsSigner`, or `VaultTransitSigner`), ensuring private keys never touch application memory.

---

## 5. Lane Checks & Pre-Flight Verification

Before routing production volume, sending businesses must verify lane health and readiness:

1. **Structural Manifest Validation**:
   - Run `corridor plan <corridor.yaml>` to inspect the execution pipeline and verify destination endpoints.
2. **On-Chain Attestation & Liveness**:
   - Verify that the receiving anchor has active, fresh attestations recorded on the Soroban registry contract using `pnpm registry:read`.
   - Probes confirm that the anchor advertises required SEPs, passes authentication challenges, and actively serves receive assets.
3. **Pre-Settle Safety Gate**:
   - The engine enforces mandatory pre-settle safety checks before funds move on chain, verifying that the anchor transaction has been accepted and that destination deposit accounts are valid.
4. **Circuit Breakers**:
   - Consecutive failures trigger the `PostgresCorridorHealthStore` breaker (`CORRIDOR_HALTED`), halting subsequent traffic to protect capital during downstream anchor outages.

---

## 6. What Stays the Business's Legal Responsibility

Using `corridor-in-a-box` does not relieve a business of legal, regulatory, or operational obligations. The sending business remains strictly responsible for:

- **Licensing**: Holding all required licenses (e.g., Money Services Business / Money Transmitter License) in every jurisdiction where it solicits or sends customer funds.
- **Consumer Protection & Disclosures**: Providing required statutory disclosures, fee receipts, FX rate transparency, and error resolution mechanisms to senders.
- **Sanctions & Terrorist Financing Screening**: Screening all senders and ultimate beneficiaries against applicable sanctions lists prior to initiating payments.
- **Counterparty Contracts**: Entering into binding bilateral commercial agreements and Service Level Agreements (SLAs) with receiving anchors.
- **Capital & Settlement Risk**: Managing working capital, pre-funding requirements, and currency volatility between quote acceptance and ledger settlement.
