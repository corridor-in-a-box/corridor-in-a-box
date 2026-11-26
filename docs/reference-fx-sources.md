# Reference FX sources

RFC 0004 ([the smart router](rfcs/0004-smart-router.md)) needs a public reference rate, such as USD/NGN, to tell whether an anchor's price is fair. It lists the choice of source as an open question, with one condition: the licence must allow republishing, because the project publishes daily summaries.

This page compares four sources and records the choice. It was written on 2026-11-25 from each provider's own pages, linked below. Terms change; read them again before relying on this.

## What a source has to do

1. Cover NGN, ZAR, MXN, PHP and KES against USD.
2. Allow the rates, or figures derived from them, to be published.
3. Update at least daily. A reference rate is compared with a day's anchor prices, not used to price a payment.
4. Cost nothing, or little, for a project with no revenue.

## Comparison

| Source                                                                                                                                 | NGN | ZAR | MXN | PHP | KES | Updates                                                          | Cost                                                             | May we republish?                         |
| -------------------------------------------------------------------------------------------------------------------------------------- | --- | --- | --- | --- | --- | ---------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------- |
| [Currency-api](https://github.com/fawazahmed0/exchange-api) (fawazahmed0)                                                              | yes | yes | yes | yes | yes | daily                                                            | free, no key, no rate limit stated                               | **Yes.** CC0 1.0                          |
| [ECB euro reference rates](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html) | no  | yes | yes | yes | no  | working days, around 16:00 CET                                   | free                                                             | **Yes, with the ECB named as the source** |
| [ExchangeRate-API](https://www.exchangerate-api.com/docs/free)                                                                         | yes | yes | yes | yes | yes | daily (open access and free key); hourly on the $10 a month plan | free, or from $10 a month                                        | **No**                                    |
| [Open Exchange Rates](https://openexchangerates.org/signup)                                                                            | yes | yes | yes | yes | yes | hourly                                                           | free for 1,000 requests a month, USD base only; from $12 a month | **Not stated; needs written permission**  |

### Currency-api

- **Licence.** The repository's `LICENSE` file is CC0 1.0 Universal, which waives the author's rights for any purpose, commercial use included. The README does not say separately that the data is under it; the licence file covers the repository as a whole.
- **Coverage.** All five currencies are in its [currency list](https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies.json), among roughly 340 codes.
- **What it does not give.** The README names no upstream source for its rates and promises no accuracy; CC0 itself offers the work "as-is". It says "Daily Updated" with no time of day. It is one person's project, served from a CDN, and the README asks callers to fall back to a second host.
- **Endpoints.** `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@{date}/v1/currencies/{code}.json`, with `{date}` as `latest` or `YYYY-MM-DD`, and the fallback `https://{date}.currency-api.pages.dev/v1/currencies/{code}.json`.

### ECB euro foreign exchange reference rates

- **Licence.** The ECB's [disclaimer and copyright page](https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html) allows free use of information from its site, on condition that reproduced information is accurate and the ECB is cited as the source, and that any change to it is stated. _I read this page through a summarising tool, so the wording here is a paraphrase and not a quotation. Check the live page before quoting it._
- **Coverage.** Thirty or so currencies against the euro. ZAR, MXN, PHP and USD are in the list; **NGN and KES are not.** A USD rate for a listed currency is a cross through the euro.
- **Caveat the ECB states.** The rates are published for information, and the ECB discourages using them for transactions. That fits a reference rate.

### ExchangeRate-API

- **Licence.** Its [terms](https://www.exchangerate-api.com/terms) say the licence "does not permit re-distribution of our data", for free and paid accounts alike. Caching is allowed for the customer's own use only. The open-access endpoint also requires an attribution link.
- **Conclusion.** Publishing daily summaries built on it is redistribution. Ruled out.

### Open Exchange Rates

- **Licence.** Its [terms](https://openexchangerates.org/terms) grant a limited, revocable right to use the information, forbid profiting from providing it or reselling access, and send any other use to their support address. Its acceptable use policy lists creating derivatives among things not to do with the site. Nothing in the terms, the services agreement or the acceptable use policy mentions publishing rates or summaries of them.
- **Conclusion.** Republishing is neither allowed nor forbidden in writing. It could only be used after asking them and getting a yes in writing. Not chosen.

## Decision

**Use Currency-api as the `reference_fx` source, and check it against the ECB rates where the ECB has the currency.**

- It is the only one of the four that covers all five currencies under terms that plainly allow republishing.
- Its weakness is provenance: no stated upstream and no accuracy promise. So the collector should not trust it alone where a second public source exists. For ZAR, MXN and PHP, compare each day's value with the ECB cross rate and record a sample as suspect when the two differ by more than a set margin. For NGN and KES there is no second source in this comparison, which the published summaries should say.
- A reference rate is used to judge prices after the fact. It must never price or route a payment.

Things still open:

- **A second source for NGN and KES.** The central banks of Nigeria and Kenya publish official rates. Their reuse terms were not examined here.

## How it is collected

The collector step is `packages/engine/src/rate-collector-reference-fx.ts`, run by `pnpm rate:collector`. [rate-history.md](rate-history.md) describes what it stores. The choices this page left open were settled there:

- **The margin** is 200 basis points. The two sources publish at different times of day, so some distance is normal. A sample further than that from the ECB cross rate is stored with `detail.ecb.status` set to `differs`.
- **The mirror order** is the one the Currency-api README asks for: jsDelivr first, then the Cloudflare Pages host. When both fail the run fails and stores nothing for that day; the next run tries again.
- **When the ECB cannot be read**, or its latest file is more than four days from the sample's day, the sample is stored as `unchecked` with the reason.
