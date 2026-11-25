// The live failure scenarios against the reference anchor (#673, #674, #675,
// #676) run on testnet in .github/workflows/reference-live-scenarios.yml and
// reference-corridor.yml. This file covers what they rely on without a network
// or a container:
//
//   - the evidence they report (examples/scenario-evidence.ts): how often a
//     payment moved on chain, the amounts just outside an anchor's limits, and
//     whether a refusal really names a limit;
//   - the engine's behaviour in each scenario, with a mock anchor doing what
//     the injected fault makes the reference anchor do, so a regression shows
//     up here before the nightly job.

import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter, type AnchorAdapter } from "@corridor/adapter-kit";
import { StaticRouteResolver } from "@corridor/router";
import { amountRangeCheck } from "@corridor/sep31";
import {
  defaultSep31Gate,
  InMemoryAuditLog,
  InMemoryIdempotencyStore,
  createMockSubmitter,
  execute,
  type EngineDeps,
  type SettlementSubmitter,
} from "@corridor/engine";
import { fail, ok, type PaymentIntent } from "@corridor/types";
import type { OnChainTransaction } from "../examples/load-test.js";
import {
  amountsOutsideLimits,
  movedAtMostOnce,
  refusalNamesLimit,
  renderScenarioSummary,
  settlementsOnChain,
} from "../examples/scenario-evidence.js";

const SIGNER = "GSIGNER";

function tx(
  hash: string,
  memo: string | undefined,
  extra: Partial<OnChainTransaction> = {},
): OnChainTransaction {
  return {
    hash,
    memo,
    createdAt: "2026-11-25T00:00:00Z",
    successful: true,
    sourceAccount: SIGNER,
    ...extra,
  };
}

describe("scenario evidence: money moved at most once", () => {
  it("passes a settled payment that appears once on chain", () => {
    const check = movedAtMostOnce(
      [tx("h1", "m1"), tx("other", "m-other")],
      { memo: "m1", stellarTxHash: "h1" },
      SIGNER,
    );
    expect(check.ok).toBe(true);
  });

  it("fails when the same payment memo left the signer twice", () => {
    const txs = [tx("h1", "m1"), tx("h2", "m1")];
    expect(settlementsOnChain(txs, { memo: "m1", stellarTxHash: "h1" }, SIGNER)).toEqual([
      "h1",
      "h2",
    ]);
    const check = movedAtMostOnce(txs, { memo: "m1", stellarTxHash: "h1" }, SIGNER);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("2 settlement(s)");
  });

  it("ignores failed transactions and ones someone else submitted", () => {
    const txs = [
      tx("h1", "m1"),
      tx("failed", "m1", { successful: false }),
      // A refund or top-up sent TO the signer carrying the same memo is not
      // the sender's money leaving.
      tx("incoming", "m1", { sourceAccount: "GANCHOR" }),
    ];
    expect(movedAtMostOnce(txs, { memo: "m1", stellarTxHash: "h1" }, SIGNER).ok).toBe(true);
  });

  it("fails when the recorded settlement is not on the ledger", () => {
    const check = movedAtMostOnce(
      [tx("h9", "m1")],
      { memo: "m1", stellarTxHash: "h1" },
      SIGNER,
    );
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("not the recorded h1");
    expect(movedAtMostOnce([], { memo: "m1", stellarTxHash: "h1" }, SIGNER).ok).toBe(false);
  });

  it("requires nothing on chain for a payment that never settled", () => {
    expect(movedAtMostOnce([tx("x", "m-other")], { memo: "m1" }, SIGNER).ok).toBe(true);
    expect(movedAtMostOnce([tx("x", "m-other")], {}, SIGNER).ok).toBe(true);
    // Opened, never settled by the engine, yet something carrying its memo left.
    expect(movedAtMostOnce([tx("x", "m1")], { memo: "m1" }, SIGNER).ok).toBe(false);
  });
});

describe("scenario evidence: amounts outside the limits", () => {
  it("steps one whole unit outside each limit", () => {
    expect(amountsOutsideLimits("5", "10")).toEqual({ below: "4", above: "11", problems: [] });
    expect(amountsOutsideLimits("2.5", "1000000")).toEqual({
      below: "1.5",
      above: "1000001",
      problems: [],
    });
  });

  it("halves a minimum of one unit or less instead of reaching zero", () => {
    expect(amountsOutsideLimits("1", "10").below).toBe("0.5");
    expect(amountsOutsideLimits("0.5", "10").below).toBe("0.25");
  });

  it("refuses to invent a case the anchor's limits do not allow", () => {
    expect(amountsOutsideLimits("0", "10").problems).toEqual([
      "the anchor's minimum is 0, so no payment is below it",
    ]);
    expect(amountsOutsideLimits(undefined, "10").problems).toEqual([
      "the anchor advertises no minimum",
    ]);
    expect(amountsOutsideLimits("5", undefined).problems).toEqual([
      "the anchor advertises no maximum",
    ]);
    expect(amountsOutsideLimits("abc", "10").problems[0]).toContain("not an amount");
    expect(amountsOutsideLimits("20", "10").problems[0]).toContain("exceeds its maximum");
  });

  it("recognises a limits refusal and nothing else", () => {
    expect(
      refusalNamesLimit('open-tx HTTP 400 — {"error":"sell_amount less than min limit"}'),
    ).toBe(true);
    expect(refusalNamesLimit("open-tx HTTP 400 — sell_amount exceeds max limit")).toBe(true);
    expect(refusalNamesLimit("amount 0.5 is below minimum 1")).toBe(true);
    expect(refusalNamesLimit("amount 600 is above maximum 500")).toBe(true);
    expect(refusalNamesLimit("reference: quote HTTP 502")).toBe(false);
    expect(refusalNamesLimit("SEP-12 customer not found")).toBe(false);
  });
});

describe("scenario evidence: job summary", () => {
  it("passes only when every check passes, and keeps table cells intact", () => {
    const pass = renderScenarioSummary(
      "Scenario",
      [{ label: "Error", value: "a | b\nc" }],
      [{ label: "x", ok: true, detail: "fine" }],
    );
    expect(pass).toContain("**PASS**");
    expect(pass).toContain("| Error | a \\| b<br>c |");

    const failed = renderScenarioSummary(
      "Scenario",
      [],
      [
        { label: "x", ok: true, detail: "fine" },
        { label: "y", ok: false, detail: "moved twice" },
      ],
    );
    expect(failed).toContain("**FAIL**");
    expect(failed).toContain("❌ y — moved twice");
    expect(renderScenarioSummary("Scenario", [], [])).toContain("**FAIL**");
  });
});

// --- the engine in each scenario, against a mock anchor --------------------

function testCorridor(): Corridor {
  const r = parseCorridor({
    id: "reference-test",
    source: {
      name: "Source",
      asset: "USDC",
      protocol: "prefunded",
      endpoints: { home_domain: "source.example" },
    },
    dest: {
      name: "Dest",
      asset: "iso4217:USD",
      endpoints: {
        home_domain: "dest.example",
        transfer_server_sep31: "https://dest.example/sep31",
        kyc_server: "https://dest.example/sep12",
        endpoints_verified_at: "1970-01-01",
      },
    },
    fx: { path: ["USD", "USDC", "USD"], who_holds_risk: "receiving_anchor" },
    compliance: {
      source_jurisdiction: "US",
      dest_jurisdiction: "US",
      sep12_sender_type: "sender",
      sep12_receiver_type: "receiver",
    },
    settlement: {
      network: "testnet",
      bridge_asset: "USDC",
      asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      strategy: "direct",
      rail: "stellar",
    },
    // Same policy as corridors/reference.corridor.yaml.
    recovery: {
      max_retries: 3,
      timeout_seconds: 900,
      refund_wait_seconds: 60,
      rollback: "refund_sender",
    },
    proof: {
      canary_completed_at: "1970-01-01T00:00:00Z",
      stellar_tx_hash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
      anchor_transaction_id: "canary-test",
      amount: "10",
      max_age_days: 50000,
    },
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/**
 * Counts submits, and refuses refunds the way the real Stellar submitter does:
 * a non-custodial sender cannot pull a payment back from the anchor.
 */
function trackingSubmitter(): SettlementSubmitter & { readonly submitCalls: number } {
  let submitCalls = 0;
  const base = createMockSubmitter();
  return {
    get submitCalls() {
      return submitCalls;
    },
    async submit(req) {
      submitCalls++;
      return base.submit(req);
    },
    async findExisting(req) {
      return base.findExisting?.(req) ?? ok(undefined);
    },
    async refund() {
      return fail("REFUND_UNSUPPORTED", "cannot be reversed on-chain", { retryable: false });
    },
  };
}

function intent(key: string, amount = "10.00"): PaymentIntent {
  return {
    idempotencyKey: key,
    corridorId: "reference-test",
    sender: { id: "s-1", sep12Id: "cust-sender" },
    recipient: { id: "r-1", sep12Id: "cust-receiver" },
    sourceAmount: { asset: "USDC", amount },
    destinationFields: {
      receiver_routing_number: "021000021",
      receiver_account_number: "12345678901234",
      type: "SWIFT",
    },
  };
}

/** A clock that never really sleeps, so reconcile budgets run instantly. */
function fakeClock(): Pick<EngineDeps, "now" | "sleep"> {
  let t = Date.parse("2026-11-25T00:00:00Z");
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function depsFor(
  adapter: AnchorAdapter,
  submitter: SettlementSubmitter,
): EngineDeps & {
  idempotency: InMemoryIdempotencyStore;
  audit: InMemoryAuditLog;
} {
  return {
    resolver: new StaticRouteResolver(() => adapter, {
      trustManifestWithoutAttestation: true,
    }),
    submitter,
    idempotency: new InMemoryIdempotencyStore(),
    audit: new InMemoryAuditLog(),
    trustManifestWithoutAttestation: true,
    unsafeSkipPreSettleGate: true,
    ...fakeClock(),
  };
}

describe("engine: amounts outside the anchor's limits (#676)", () => {
  it("fails before settle when the anchor refuses to open an out-of-range amount", async () => {
    const submitter = trackingSubmitter();
    const base = createMockAdapter();
    // What the Anchor Platform answers POST /sep31/transactions with.
    const adapter: AnchorAdapter = {
      ...base,
      async openTransaction() {
        return fail(
          "ANCHOR_UNAVAILABLE",
          'reference: open-tx HTTP 400 — {"error":"sell_amount less than min limit"}',
          { retryable: false },
        );
      },
    };
    const deps = depsFor(adapter, submitter);

    const result = await execute(intent("limits-open", "4"), testCorridor(), deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(refusalNamesLimit(result.error.message)).toBe(true);
    const stored = await deps.idempotency.get("limits-open");
    expect(stored?.state).toBe("failed");
    expect(stored?.stellarTxHash).toBeUndefined();
    expect(submitter.submitCalls).toBe(0);
  });

  it.each([
    ["below the minimum", "0.50", "below minimum 1"],
    ["above the maximum", "600.00", "above maximum 500"],
  ])("refuses an amount %s at the pre-settle gate too", async (_name, amount, message) => {
    const submitter = trackingSubmitter();
    const c = testCorridor();
    const info = {
      async getInfo() {
        return ok({
          receive: { [c.settlement.bridge_asset]: { minAmount: "1", maxAmount: "500" } },
        });
      },
    };
    const deps: EngineDeps = {
      ...depsFor(createMockAdapter(), submitter),
      unsafeSkipPreSettleGate: false,
      gate: defaultSep31Gate({ checks: [amountRangeCheck(info)] }),
      unprovenMaxAmount: "10000.00",
    };

    const result = await execute(intent(`limits-gate-${amount}`, amount), c, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PRESETTLE_AMOUNT_OUT_OF_RANGE");
      expect(result.error.message).toContain(message);
      expect(refusalNamesLimit(result.error.message)).toBe(true);
    }
    expect(submitter.submitCalls).toBe(0);
  });
});

describe("engine: the anchor asks for more customer information (#673)", () => {
  it("parks the payment in held after it settled once, never settling again", async () => {
    const submitter = trackingSubmitter();
    const base = createMockAdapter();
    // `faults ask-info`: the anchor has the funds and moves the transaction to
    // pending_customer_info_update instead of paying out.
    const adapter: AnchorAdapter = {
      ...base,
      async getTransaction(id) {
        const s = await base.getTransaction(id);
        if (!s.ok) return s;
        return ok({
          ...s.value,
          status: "pending_customer_info_update",
          settled: false,
          awaitingInput: true,
        });
      },
    };
    const deps = depsFor(adapter, submitter);

    const result = await execute(intent("ask-info"), testCorridor(), deps);

    expect(result.ok).toBe(false);
    const stored = await deps.idempotency.get("ask-info");
    expect(stored?.state).toBe("held");
    expect(stored?.stellarTxHash).toBeDefined();
    expect(submitter.submitCalls).toBe(1);
    const trail = deps.audit.entries.map((e) => e.to);
    expect(trail).toContain("recovering");
    expect(trail.at(-1)).toBe("held");
  });
});

describe("engine: the anchor goes down during the flow (#675)", () => {
  it("keeps polling through the outage and completes once, after the anchor returns", async () => {
    const submitter = trackingSubmitter();
    const base = createMockAdapter();
    // `faults outage=N`: the anchor holds the funds, then stops answering for a
    // while, then pays out.
    let polls = 0;
    const adapter: AnchorAdapter = {
      ...base,
      async getTransaction(id) {
        polls++;
        if (polls === 1) {
          const s = await base.getTransaction(id);
          if (!s.ok) return s;
          return ok({ ...s.value, status: "pending_receiver", settled: false });
        }
        if (polls <= 15) {
          return fail("ANCHOR_UNAVAILABLE", "fetch failed: connect ECONNREFUSED", {
            retryable: true,
          });
        }
        return base.getTransaction(id);
      },
    };
    const deps = depsFor(adapter, submitter);

    const result = await execute(intent("outage"), testCorridor(), deps);

    expect(result.ok).toBe(true);
    const stored = await deps.idempotency.get("outage");
    expect(stored?.state).toBe("completed");
    expect(polls).toBeGreaterThan(15);
    expect(submitter.submitCalls).toBe(1);
  });

  it("does not settle a second time when the same payment is run again", async () => {
    const submitter = trackingSubmitter();
    const deps = depsFor(createMockAdapter(), submitter);
    const c = testCorridor();

    expect((await execute(intent("outage-replay"), c, deps)).ok).toBe(true);
    expect((await execute(intent("outage-replay"), c, deps)).ok).toBe(true);
    expect(submitter.submitCalls).toBe(1);
  });
});

describe("engine: the payout fails and the anchor refunds (#674)", () => {
  it("ends refunded with exactly one settlement", async () => {
    const submitter = trackingSubmitter();
    const adapter = createMockAdapter({
      terminalFailure: true,
      refundStatus: {
        amountRefunded: { asset: "USDC", amount: "10.00" },
        amountFee: { asset: "USDC", amount: "0.00" },
        payments: [
          {
            id: "refund-tx-1",
            amount: { asset: "USDC", amount: "10.00" },
            fee: { asset: "USDC", amount: "0.00" },
          },
        ],
        completeness: "full",
      },
    });
    const deps = depsFor(adapter, submitter);

    const result = await execute(intent("refund"), testCorridor(), deps);

    expect(result.ok).toBe(false);
    const stored = await deps.idempotency.get("refund");
    expect(stored?.state).toBe("refunded");
    expect(submitter.submitCalls).toBe(1);
    const trail = deps.audit.entries.map((e) => e.to);
    expect(trail).toContain("refund_pending");
    expect(trail.at(-1)).toBe("refunded");
  });
});
