# Public Onboarding Requirements: Cowrie, Zeam, and MyKobo

This note summarizes what **public documentation, websites, legal terms, open repositories, and live Stellar SEP probes** reveal about onboarding a sending partner for three target receiving anchors: **Cowrie**, **Zeam**, and **MyKobo**.

Scope rule: only publicly accessible sources and this repository's verified probe records are used below. Where an anchor does not publish partner KYB checklists, field schemas, or API onboarding steps openly, that gap is stated explicitly rather than inferred.

---

## Summary Comparison

| Anchor              | Home Domain       | Published SEPs / APIs Verified in Repo                                                       | Public Partner KYB Checklist / Schema Published?                           | Public Onboarding Channel                            |
| ------------------- | ----------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Cowrie Exchange** | `cowrie.exchange` | SEP-1, SEP-10, SEP-12, SEP-31 (no SEP-38)                                                    | **No** (private bilateral onboarding)                                      | Direct email (`info@cowriesys.com`)                  |
| **Zeam**            | `mint.zeam.money` | SEP-1, SEP-10, SEP-12, SEP-31, SEP-38                                                        | **No** (high-level gateway/Sumsub references only)                         | Direct developer contact (`developers@zeam.app`)     |
| **MyKobo**          | `mykobo.co`       | Advertises SEP-1, SEP-6, SEP-24, SEP-31 (`stellar.mykobo.co` unresolved on 2026-10-16 probe) | **No** (Terms cover Legal Persons generally; no public B2B KYB field spec) | Website / support via [mykobo.co](https://mykobo.co) |

---

## 1. Cowrie (`cowrie.exchange` / `cowriesys.com`)

### Public sources & verified facts

- **Operator:** Cowrie Integrated Systems Limited (Lagos, Nigeria), publishing Stellar anchor endpoints at [`cowrie.exchange`](https://cowrie.exchange/.well-known/stellar.toml) and corporate information at [`cowriesys.com`](https://www.cowriesys.com).
- **Verified protocol surface (probed 2026-10-17 in [`corridors/ng-cowrie.corridor.yaml`](../../corridors/ng-cowrie.corridor.yaml)):**
  - `DIRECT_PAYMENT_SERVER` (SEP-31): `https://api.cowrie.exchange/sep31/direct` (reported non-empty receive list: `NGNT`, `USDC`)
  - `WEB_AUTH_ENDPOINT` (SEP-10): `https://api.cowrie.exchange/web_auth`
  - `KYC_SERVER` (SEP-12): `https://api.cowrie.exchange/kyc`
  - No `ANCHOR_QUOTE_SERVER` (SEP-38) is published (`fx.quote_source: external`).
- **Public technical reference:** Cowrie's public GitHub organization ([`github.com/cowriesys`](https://github.com/cowriesys) and [`cowriesys/stellarator`](https://github.com/cowriesys/stellarator)) documents standard SEP-6 / SEP-10 / SEP-12 integration patterns (including local identity references / Nigerian BVN & NUBAN validation and `CUSTOMER-ID` registration).
- **Direct contact published:** `info@cowriesys.com` (and `vas@cowriesys.com` for VAS APIs); Lagos office address listed as 16 Idowu Martins Street, Victoria Island, Lagos, Nigeria.

### Documented partner onboarding steps & fields

- **What is published:** Contact-based institutional coordination (`info@cowriesys.com`) for FX liquidity, stablecoin settlement pipelines, and sandbox/production credentials.
- **What is NOT published:** Cowrie does **not** publish a public self-serve KYB portal, sending-partner application form, fixed corporate document checklist, jurisdiction-by-jurisdiction licence list, or proprietary off-protocol partner API specification on `cowriesys.com`.

---

## 2. Zeam (`mint.zeam.money` / `zeam.money`)

### Public sources & verified facts

- **Platform & operator:** Zeam (developed by Paytec Group), operating [`zeam.money`](https://zeam.money) and Stellar anchor home domain [`mint.zeam.money`](https://mint.zeam.money/.well-known/stellar.toml).
- **Verified protocol surface (probed 2026-10-17 in [`corridors/zeam.corridor.yaml`](../../corridors/zeam.corridor.yaml) and [`contracts/anchors.json`](../../contracts/anchors.json)):**
  - `DIRECT_PAYMENT_SERVER` (SEP-31): `https://anchor.zeam.money/sep31`
  - `WEB_AUTH_ENDPOINT` (SEP-10): `https://anchor.zeam.money/auth`
  - `KYC_SERVER` (SEP-12): `https://anchor.zeam.money/customer`
  - `ANCHOR_QUOTE_SERVER` (SEP-38): `https://anchor.zeam.money/sep38`
  - Live `/sep31/info` on 2026-10-17 declared `quotes_supported: true` for `USDC` (`min_amount: "1"`, `max_amount: "10000"`) and named SEP-12 customer types `sep31-sender` and `sep31-receiver`.
  - Its `stellar.toml` anchors fiat tokens including `ZARZ` (referencing South African Reserve Bank TPP registration `SO001233`) and `GBPZ`.
- **Public API gateway & compliance documentation:**
  - Zeam documents a single REST gateway (`api.zeam.money`) with bearer token authentication scoped to a business tenant ("association"), `X-Request-Id`, idempotency keys, HMAC webhook verification, and public SDK repositories on GitHub (`zeam-sdk-go`, `@zeammoney/sdk`, `zeam_sdk`).
  - Public [Sumsub](https://sumsub.com) customer case material notes that Zeam uses Sumsub for KYC, AML screening, and automated KYB workflows.
  - Developer outreach channel referenced publicly: `developers@zeam.app`.

### Documented partner onboarding steps & fields

- **What is published:** Server-side application integration uses scoped tenant credentials requested via developer/solutions walkthrough channels (`developers@zeam.app`), with SEP-10 + SEP-12 customer types (`sep31-sender`, `sep31-receiver`) exposed via Stellar endpoints.
- **What is NOT published:** Exact required KYB field names, mandatory corporate document lists per operating country, SLA/approval timelines, and sandbox self-registration endpoints are **not** publicly published.

---

## 3. MyKobo (`mykobo.co`)

### Public sources & verified facts

- **Legal entity & regulator (published on [`mykobo.co`](https://mykobo.co)):**
  - Operated by **MYKOBO sp. z o.o.** (legal entity code `0001133842`), registered at ul. Bartycka 22B/21A, Warsaw 00-716, Poland.
  - Operates as a Virtual Asset Service Provider (VASP) supervised by Poland's General Inspector of Financial Information (GIFI), governed by the Polish Act on the Prevention of Money Laundering and Terrorist Financing and EU GDPR (`Privacy Policy`).
- **Stellar directory & probe status ([`contracts/anchors.json`](../../contracts/anchors.json)):**
  - Listed in the [Stellar Anchor Directory](https://anchors.stellar.org/?search=MyKobo); its `stellar.toml` advertises SEP-6, SEP-24, and SEP-31.
  - Probed 2026-10-16: the advertised API host (`stellar.mykobo.co`) failed DNS resolution at probe time and MyKobo's status page listed the anchor service as down, so live SEP-12 / SEP-31 `/info` fields could not be retrieved.
- **Legal terms & compliance disclosures:**
  - MyKobo's Terms of Service explicitly contemplate **Legal Persons** as well as natural persons: a legal entity warrants valid organization and authorization of its acting representative, and agrees to AML/CTF, PEP, fraud, and sanctions (UN, OFAC) screening and periodic reviews.

### Documented partner onboarding steps & fields

- **What is published:** Terms of Service and Privacy Policy establishing VASP AML/CTF obligations for both natural and legal persons, plus standard Stellar anchor discovery via SEP-1 (`stellar.toml`) and SEP-10/SEP-12/SEP-6/SEP-24/SEP-31 protocols.
- **What is NOT published:** MyKobo does **not** publish a public B2B partner KYB pack specification, required corporate document list for API integrators, or self-serve partner sandbox credential portal on `mykobo.co`. Runtime SEP-12 requirements can only be inspected dynamically when the anchor endpoints are online.

---

## Implications for Corridor Exporters

Because **none of Cowrie, Zeam, or MyKobo publicly publishes a machine-readable or static partner KYB schema**, exporters cannot invent anchor-specific partner fields today:

1. Exporters built against public information must start with targets we control (such as the local reference anchor in `scripts/reference-anchor.sh`) or live SEP-12 `GET /customer` schema responses where exposed.
2. Collecting the canonical fields in the v0 company profile schema (`schemas/company-profile.v0.schema.json`) prepares legal entity, registration, licensing, UBO/director, AML/CFT summary, Stellar account, contact, and hashed document references ahead of bilateral KYB review with any of these anchors.
