# Rate history

Where the corridor engine records and summarizes the prices it uses. This
page documents the rate history that RFC 0004 §3
([docs/rfcs/0004-smart-router.md](rfcs/0004-smart-router.md#3-rate-history))
specifies: four rate sources, a 15-minute collection cadence into
Postgres, a daily summary, and a minimum-data rule.

## Sources

Per RFC 0004 §3, each source is recorded as its own series (never mixed):

- **SEP-38 indicative** — anchor-published SEP-38 prices (`sep38_price`
  samples, `packages/engine/src/rate-collector-sep38.ts`).
  - Measures: the indicative rate an attested anchor publishes for each of
    its pairs, stored as buy units per one sell unit, fees included. An
    indicative price is never treated as firm.
  - Fetched from: the quote server named by `ANCHOR_QUOTE_SERVER` in the
    anchor's own `stellar.toml` (never guessed from the domain). The
    collector reads `GET /info` for the assets, `GET /prices` for the pairs
    and `GET /price` once per pair at a reference amount. Each sample is
    tagged with the anchor domain.
  - Licence: each anchor's own terms — check the anchor's terms before
    republishing its prices. Corridor stores no source-licence data.
- **DEX** — Stellar DEX trade prices (`dex_trade` samples,
  `packages/engine/src/rate-collector-dex.ts`).
  - Measures: the closing price of each 15-minute bucket for the pairs in
    `config/dex-pairs.json`, an independent cross-check on anchor prices.
    Buckets with no trades are skipped, and a DEX sample belongs to no
    anchor.
  - Fetched from: Horizon `/trade_aggregations` at 15-minute resolution.
  - Licence: public ledger data.
- **Reference FX** — a public reference FX rate (`reference_fx` samples,
  `packages/engine/src/rate-collector-reference-fx.ts`).
  - Measures: the day's market FX rate for each pair in
    `config/reference-fx-pairs.json` (USD against NGN, ZAR, MXN, PHP and
    KES), to compare anchor prices against. One sample per pair per day,
    stored as quote units per one base unit, with the assets written
    `iso4217:USD` and `iso4217:NGN`. A reference sample belongs to no
    anchor. It is used to judge prices after the fact and never prices or
    routes a payment.
  - Fetched from: [Currency-api](https://github.com/fawazahmed0/exchange-api),
    its jsDelivr host first and its Cloudflare Pages mirror second. The
    rate is stored as the digits written in the file.
  - Cross-check: Currency-api names no upstream source, so each sample is
    compared with the ECB euro reference rates where the ECB lists both
    currencies (ZAR, MXN, PHP). The sample's `detail.ecb` records
    `agrees` or `differs` (more than 200 basis points apart), with the
    ECB cross rate and its date. A sample that differs is kept and
    marked, not dropped. The ECB lists neither NGN nor KES, so those
    samples are `unchecked`: **for NGN and KES the reference rate rests
    on one source.**
  - Licence: Currency-api is CC0 1.0, which allows republishing. The ECB
    rates may be reused with the ECB named as the source; only a
    comparison against them is stored. The choice and the sources that
    were ruled out are in
    [reference-fx-sources.md](reference-fx-sources.md).
- **Own payment** — the business's own completed payments.
  - Measures: the effective rate (`amount_out / amount_in`) of the
    business's own completed payments — the only data for anchors that
    publish no price. It is not the bridge asset's rate from the manifest.
  - Fetched from: the business's own completed payments; to confirm — not
    collected yet.

## Collection

Every 15 minutes (RFC 0004 §3), an always-on, read-only collector writes
samples into Postgres (`rate_samples`, created by
`packages/engine/src/rate-samples-pg.ts`). It reads only public data, so
running it keeps the project non-custodial. It does not run on GitHub
Actions, whose schedules are too unreliable for a 15-minute cadence.

Run it with `DATABASE_URL=postgres://... pnpm rate:collector`
(`examples/run-rate-collector.ts`, a `RateCollectorLoop` from
`packages/engine/src/rate-collector-loop.ts`). Each run polls SEP-38 prices,
reads the DEX pairs and then reads the reference FX rates; a run that is
still going when the next one is due makes that next one skip. The reference
FX source changes once a day, so that step reads it at most once an hour and
a repeat of the same day stores nothing. The settings are in `.env.example`.

## Daily summary

Per RFC 0004 §3, a daily summary per pair is the **min, P25, median, P75,
max and sample count** (`rate_daily_summaries`), published as JSON so
anyone can check the numbers the router uses.

## Minimum-data rule

An anchor gets the `estimated` price label only with at least 7 days of
data and at least 100 samples in the window. Below that it is unpriceable.

## Retention

Raw samples are kept for **90 whole UTC days** by default, set with
`RATE_RETENTION_DAYS` (#599). It can never be set below 7 days: the
minimum-data rule above and the default 7-day estimate window (RFC 0004 D3)
read raw samples. Daily summaries are kept forever.

Once a day the collector deletes older samples in batches
(`packages/engine/src/rate-pruning.ts`), and only for a series and UTC day
whose daily summary has been written after the samples were recorded. A day
with no summary keeps all its raw samples. Until a job writes daily summaries,
nothing is pruned. The details are in
[operations.md](operations.md#rate-history).

## Links

- [RFC 0004 §3](rfcs/0004-smart-router.md#3-rate-history) — the design
- [README.md](../README.md) — the docs index
