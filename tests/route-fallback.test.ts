// Route fallback (RFC 0004): when a route fails BEFORE any funds move — a
// refused quote, a KYC rejection, a transaction the anchor cannot open, or a
// pre-settle gate refusal — the engine marks that run failed and starts a linked
// run on the next option under `<key>:altN`. Once a run reaches `settling` the
// route is pinned: a later failure never falls back, and a resume that would
// resolve to a different anchor is refused with ROUTE_PINNED.
//
// The failures here are injected per adapter/step, so each case proves the
// "before funds move" boundary from the outside: money moved zero times, the
// failed run's audit entry points at the alternate, and the alternate's first
// entry points back.

import { describe, expect, it } from "vitest";
import { hashCorridor, parseCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter, type AnchorAdapter } from "@corridor/adapter-kit";
import type { RouteCandidate, RouteResolver } from "@corridor/router";
import {
  InMemoryAuditLog,
  InMemoryIdempotencyStore,
  createMockSubmitter,
  execute,
} from "@corridor/engine";
import type {
  CheckResult,
  EngineDeps,
  PreSettleGate,
  SettlementSubmitter,
} from "@corridor/engine";
import { fail, type PaymentIntent } from "@corridor/types";

const DEPOSIT = "GALT0000000000000000000000000000000000000000000000000";
const AMOUNT = "100.00";

function corridor(): Corridor {
  const r = parseCorridor({
    id: "test",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: {
      name: "D",
      asset: "iso4217:ARS",
      endpoints: {
        home_domain: "d.example",
        transfer_server_sep31: "https://d.example/sep31",
        endpoints_verified_at: "1970-01-01",
      },
    },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER" },
    recovery: { max_retries: 2, rollback: "manual" },
    proof: {
      canary_completed_at: "1970-01-01T00:00:00Z",
      stellar_tx_hash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
      anchor_transaction_id: "canary-test",
      amount: "1",
      max_age_days: 50000,
    },
  });
  if (!r.ok) throw new Error(`fallback corridor invalid: ${r.error.message}`);
  return r.value;
}

function intent(key: string): PaymentIntent {
  return {
    idempotencyKey: key,
    corridorId: "test",
    sender: { id: "s" },
    recipient: { id: "r" },
    sourceAmount: { asset: "USDC", amount: AMOUNT },
  };
}

const PASSING_CHECKS: CheckResult[] = [
  { name: "test.check", passed: true, detail: "ok", durationMs: 0 },
];

const passingGate: PreSettleGate = {
  evaluate: async () => ({ passed: true, results: PASSING_CHECKS }),
};

/** One adapter that refuses a single pre-settle step; everything else works. */
function failingAdapter(name: string, step: "quote" | "comply" | "open"): AnchorAdapter {
  const base = createMockAdapter({ name });
  return {
    ...base,
    name,
    requestQuote:
      step === "quote"
        ? async () =>
            fail("QUOTE_UNAVAILABLE", `${name} refused the quote`, { retryable: false })
        : base.requestQuote,
    ensureCompliance:
      step === "comply"
        ? async () => fail("KYC_REJECTED", `${name} rejected the sender`, { retryable: false })
        : base.ensureCompliance,
    openTransaction:
      step === "open"
        ? async () =>
            fail("ANCHOR_UNAVAILABLE", `${name} could not open a transaction`, {
              retryable: false,
            })
        : base.openTransaction,
  };
}

function resolverFor(primary: AnchorAdapter, alternates: AnchorAdapter[]): RouteResolver {
  return {
    async resolve(): Promise<RouteCandidate & { alternates?: readonly RouteCandidate[] }> {
      return {
        receiving: primary,
        trust: "manifest",
        ...(alternates.length > 0 && {
          alternates: alternates.map((receiving) => ({
            receiving,
            trust: "manifest" as const,
          })),
        }),
      };
    },
  };
}

function deps(resolver: RouteResolver, submitter: SettlementSubmitter): EngineDeps {
  return {
    resolver,
    submitter,
    gate: passingGate,
    idempotency: new InMemoryIdempotencyStore(),
    trustManifestWithoutAttestation: true,
  };
}

describe("engine route fallback (RFC 0004)", () => {
  it.each(["quote", "comply", "open"] as const)(
    "a %s failure before funds move falls back to the next option",
    async (step) => {
      const baseKey = `fallback-${step}`;
      const primary = failingAdapter("anchor-primary", step);
      const alternate = createMockAdapter({ name: "anchor-alt-1" });
      const d = deps(resolverFor(primary, [alternate]), createMockSubmitter());
      const audit = new InMemoryAuditLog();
      d.audit = audit;

      const r = await execute(intent(baseKey), corridor(), d);

      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.idempotencyKey).toBe(`${baseKey}:alt1`);
        expect(r.value.state).toBe("completed");
      }

      // The primary is marked failed and points forward to the linked run.
      const primaryRun = await d.idempotency!.get(baseKey);
      expect(primaryRun?.state).toBe("failed");
      expect(primaryRun?.receivingDomain).toBe("d.example");
      const failedEntry = audit.entries.find(
        (e) => e.idempotencyKey === baseKey && e.to === "failed",
      );
      expect(failedEntry?.fallbackTo).toBe(`${baseKey}:alt1`);

      // The alternate succeeded and points back at the primary.
      const altRun = await d.idempotency!.get(`${baseKey}:alt1`);
      expect(altRun?.state).toBe("completed");
      const altFirst = audit.entries.find(
        (e) => e.idempotencyKey === `${baseKey}:alt1` && e.to === "quoted",
      );
      expect(altFirst?.fallbackFrom).toBe(baseKey);
    },
  );

  it("a pre-settle gate refusal falls back to the next option", async () => {
    const baseKey = "fallback-gate";
    let evaluations = 0;
    const refusingOnce: PreSettleGate = {
      evaluate: async () => {
        evaluations += 1;
        if (evaluations === 1) {
          return {
            passed: false,
            results: [
              {
                name: "sep12.receiver",
                passed: false,
                code: "KYC_REJECTED",
                detail: "receiver not accepted at the primary anchor",
                durationMs: 0,
              },
            ],
          };
        }
        return { passed: true, results: PASSING_CHECKS };
      },
    };
    const d = deps(
      resolverFor(createMockAdapter({ name: "anchor-primary" }), [
        createMockAdapter({ name: "anchor-alt-1" }),
      ]),
      createMockSubmitter(),
    );
    d.gate = refusingOnce;
    const audit = new InMemoryAuditLog();
    d.audit = audit;

    const r = await execute(intent(baseKey), corridor(), d);

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.idempotencyKey).toBe(`${baseKey}:alt1`);
    expect((await d.idempotency!.get(baseKey))?.state).toBe("failed");
    expect((await d.idempotency!.get(`${baseKey}:alt1`))?.state).toBe("completed");
    expect(
      audit.entries.find((e) => e.idempotencyKey === baseKey && e.to === "failed")?.fallbackTo,
    ).toBe(`${baseKey}:alt1`);
  });

  it("tries a second alternate when the first one also fails pre-settle", async () => {
    const baseKey = "fallback-chain";
    const d = deps(
      resolverFor(failingAdapter("anchor-primary", "quote"), [
        failingAdapter("anchor-alt-1", "comply"),
        createMockAdapter({ name: "anchor-alt-2" }),
      ]),
      createMockSubmitter(),
    );
    const audit = new InMemoryAuditLog();
    d.audit = audit;

    const r = await execute(intent(baseKey), corridor(), d);

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.idempotencyKey).toBe(`${baseKey}:alt2`);
    expect((await d.idempotency!.get(`${baseKey}:alt1`))?.state).toBe("failed");
    expect((await d.idempotency!.get(`${baseKey}:alt2`))?.state).toBe("completed");
    expect(
      audit.entries.find((e) => e.idempotencyKey === `${baseKey}:alt1` && e.to === "failed")
        ?.fallbackTo,
    ).toBe(`${baseKey}:alt2`);
    expect(
      audit.entries.find((e) => e.idempotencyKey === `${baseKey}:alt1` && e.to === "quoted")
        ?.fallbackFrom,
    ).toBe(baseKey);
  });

  it("stops after maxAlternates alternates", async () => {
    const baseKey = "fallback-limit";
    const d = deps(
      resolverFor(failingAdapter("anchor-primary", "quote"), [
        failingAdapter("anchor-alt-1", "quote"),
        createMockAdapter({ name: "anchor-alt-2" }),
      ]),
      createMockSubmitter(),
    );
    d.maxAlternates = 1;

    const r = await execute(intent(baseKey), corridor(), d);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("QUOTE_UNAVAILABLE");
    expect((await d.idempotency!.get(`${baseKey}:alt1`))?.state).toBe("failed");
    expect(await d.idempotency!.get(`${baseKey}:alt2`)).toBeUndefined();
  });

  it("maxAlternates: 0 disables fallback", async () => {
    const baseKey = "fallback-off";
    const d = deps(
      resolverFor(failingAdapter("anchor-primary", "quote"), [
        createMockAdapter({ name: "anchor-alt-1" }),
      ]),
      createMockSubmitter(),
    );
    d.maxAlternates = 0;

    const r = await execute(intent(baseKey), corridor(), d);

    expect(r.ok).toBe(false);
    expect(await d.idempotency!.get(`${baseKey}:alt1`)).toBeUndefined();
  });

  it("does not fall back after settlement has started", async () => {
    const baseKey = "fallback-settled";
    const base = createMockSubmitter();
    let submitAttempts = 0;
    const submitter: SettlementSubmitter = {
      ...base,
      submit: async () => {
        submitAttempts += 1;
        return fail("SETTLEMENT_FAILED", "settle refused after money was submitted", {
          retryable: false,
        });
      },
    };
    const d = deps(
      resolverFor(createMockAdapter({ name: "anchor-primary" }), [
        createMockAdapter({ name: "anchor-alt-1" }),
      ]),
      submitter,
    );
    const audit = new InMemoryAuditLog();
    d.audit = audit;

    const r = await execute(intent(baseKey), corridor(), d);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SETTLEMENT_FAILED");
    expect(submitAttempts).toBe(1);
    expect((await d.idempotency!.get(baseKey))?.state).toBe("failed");
    // No linked run was started, and the failed entry points at nothing.
    expect(await d.idempotency!.get(`${baseKey}:alt1`)).toBeUndefined();
    const failedEntry = audit.entries.find(
      (e) => e.idempotencyKey === baseKey && e.to === "failed",
    );
    expect(failedEntry?.fallbackTo).toBeUndefined();
  });

  it("refuses to re-route a run that has reached settling", async () => {
    const c = corridor();
    const store = new InMemoryIdempotencyStore();
    await store.put({
      idempotencyKey: "pinned",
      corridorId: c.id,
      manifestHash: hashCorridor(c),
      state: "settling",
      version: 5,
      transactionId: "tx_pinned",
      quoteId: "q_pinned",
      quoteExpiresAt: Date.now() + 60_000,
      quoteFirm: true,
      settlementAmount: AMOUNT,
      depositAddress: DEPOSIT,
      memo: "memo",
      memoType: "text",
      // Opened against a different receiving domain than the corridor resolves now.
      receivingDomain: "other.example",
    });

    const base = createMockSubmitter();
    let submitAttempts = 0;
    const submitter: SettlementSubmitter = {
      ...base,
      submit: async (req) => {
        submitAttempts += 1;
        return base.submit(req);
      },
    };
    const d = deps(resolverFor(createMockAdapter({ name: "anchor-alt-1" }), []), submitter);
    d.idempotency = store;

    const r = await execute(intent("pinned"), c, d);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("ROUTE_PINNED");
    // The read path is the only thing that ran: nothing submitted, and the
    // stored run is left exactly as it was, resumable once the route agrees.
    expect(submitAttempts).toBe(0);
    const stored = await store.get("pinned");
    expect(stored?.state).toBe("settling");
    expect(stored?.version).toBe(5);
  });
});
