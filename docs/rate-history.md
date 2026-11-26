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
- **Reference FX** — a public reference FX rate.
  - Measures: the market FX rate for a fiat pair, to compare anchor prices
    against.
  - Fetched from: to confirm — the provider is still to be chosen, and its
    licence must allow republishing.
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
`packages/engine/src/rate-collector-loop.ts`). Each run polls SEP-38 prices
and then reads the DEX pairs; a run that is still going when the next one is
due makes that next one skip. The settings are in `.env.example`.

## Daily summary

Per RFC 0004 §3, a daily summary per pair is the **min, P25, median, P75,
max and sample count** (`rate_daily_summaries`), published as JSON so
anyone can check the numbers the router uses.

## Minimum-data rule

An anchor gets the `estimated` price label only with at least 7 days of
data and at least 100 samples in the window. Below that it is unpriceable.

## Retention

To confirm — how long raw samples are kept is not decided yet.

## Links

- [RFC 0004 §3](rfcs/0004-smart-router.md#3-rate-history) — the design
- [README.md](../README.md) — the docs index
