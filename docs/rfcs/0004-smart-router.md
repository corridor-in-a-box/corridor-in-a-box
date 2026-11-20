# RFC 0004 — Smart router: fall back before funds move

- **Status:** Accepted
- **Date:** 2026-11-20
- **Supersedes:** nothing
- **Related:** [`0001-protocol-agnostic-corridors.md`](./0001-protocol-agnostic-corridors.md), [`docs/route-resolver.md`](../route-resolver.md)

## Context

`RouteResolver` returns one receiving anchor. If the anchor refuses a quote,
rejects the sender's KYC, or cannot open a transaction, the run ends `failed`
and the payment stops — even when another anchor on the corridor could have
served it. Operators cannot express "try the next one" without adding code to
the engine.

The safety boundary is settlement. Before `settling`, nothing irreversible has
happened: quote, compliance, opening a transaction, and even a pre-settle gate
refusal all leave the money where it was. After `settling`, the engine has
submitted (or may have submitted) a payment that cannot be reversed by switching
anchors; reconciling against a different anchor would poll the wrong
transaction. So fallback must exist, and it must stop dead at settlement.

## Decision

1. `RouteDecision` gains an optional, ordered `alternates: RouteOption[]`.
   `RouteOption` is the existing decision minus `split`: a receiving anchor, an
   optional sending anchor, and `trust`. Resolvers that return a single anchor
   leave it unset and the engine behaves exactly as before.
2. `EngineDeps.maxAlternates` bounds how many alternates are tried. Default `2`.
   `0` disables fallback.
3. A pre-settle failure on option _N_:
   - marks that run `failed` as it does today, with
     `AuditEntry.fallbackTo = "<key>:alt<N+1>"`;
   - starts a linked run under `<key>:alt<N+1>` with
     `AuditEntry.fallbackFrom = "<key>:alt<N>"` on its first transition.
4. A failure at or after `settling` never falls back, never stamps
   `fallbackTo`, and is returned to the caller unchanged.
5. The receiving anchor's `name` is recorded on the run as `receivingAnchor` the
   first time a route is chosen. On resume, if the run has reached `settling`
   (or any state after it, including `retrying`, `settled`, `recovering`,
   `refund_pending`) and the resolver now returns a different name, resume is
   refused with `ROUTE_PINNED` (HTTP 409). The stored run is left untouched and
   can be resumed when the resolver agrees again.

### What counts as "before funds move"

`failed` alone is not enough: a post-settle reconcile failure under
`rollback: manual` also ends `failed`. The engine falls back only when, at the
moment of the failure:

- the run never entered `settling` (tracked in-process), and
- no source deposit was opened (`sourceTransactionId` is unset), so no treasury
  money has left for this run, and
- the failure is not `DRY_RUN_COMPLETE` (an operator-requested stop is not a
  route problem).

`held` and `refunded` never fall back: they mean money moved.

## Audit trail

A failed primary and its successor are two normal runs, each with a complete
trail of its own, joined by one field on each side:

```
run A (key)          created -> quoted -> failed            fallbackTo: "key:alt1"
run B (key:alt1)     created -> quoted -> ... -> completed   fallbackFrom: "key"
```

The link is recorded once per direction, on the transition that makes it true.
`fallbackTo` is written only on a pre-settle failure, so the absence of the
field on a failed entry is itself evidence that money may have moved.

## Consequences

- Resolver authors opt in by returning `alternates`; nothing changes for the
  shipped `StaticRouteResolver` and `RegistryRouteResolver`.
- Alternates are not re-resolved. They belong to the decision that produced
  them, so a resolver cannot change the ordering mid-payment.
- Idempotency keys are per attempt (`<key>:altN`), so the caller's key still
  identifies the payment group while each attempt remains independently
  resumable and auditable. A retry with the caller's original key while all
  alternates are exhausted returns the last attempt's terminal outcome through
  the normal idempotency conflict path.
- Fallback does not bypass the pre-settle gate: the alternate runs every gate
  check itself before it may settle.

## Tests

`tests/route-fallback.test.ts` drives the engine with adapters that fail at one
pre-settle step (quote, comply, open, gate) and asserts the linked run succeeds;
then fails the settle leg and asserts no alternate is started and no
`fallbackTo` is recorded; then resumes a `settling` run against a different
anchor and asserts `ROUTE_PINNED` with the stored row untouched.
