// Unit tests covering the 4 live testnet failure scenarios:
// - Issue #676: Amounts outside anchor limits
// - Issue #673: Anchor asks for customer info (NEEDS_INFO)
// - Issue #675: Anchor down during the flow (outage & recovery)
// - Issue #674: Payout fails and anchor refunds

import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter, type AnchorAdapter, type KycResult } from "@corridor/adapter-kit";
import { StaticRouteResolver } from "@corridor/router";
import {
  amountRangeCheck,
  receiverKycCheck,
  type ReceiverKycAdapterLike,
} from "@corridor/sep31";
import {
  defaultSep31Gate,
  InMemoryAuditLog,
  InMemoryIdempotencyStore,
  createMockSubmitter,
  execute,
  type EngineDeps,
  type SettlementSubmitter,
} from "@corridor/engine";
import { fail, ok, type Outcome, type PaymentIntent } from "@corridor/types";

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
    recovery: {
      max_retries: 0,
      timeout_seconds: 30,
      refund_wait_seconds: 1,
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

function makeTrackingSubmitter(): SettlementSubmitter & { submitCalls: number } {
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
    async refund(req) {
      return base.refund(req);
    },
  };
}

function makeIntent(key: string, amount: string = "10.00"): PaymentIntent {
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

describe("Live Testnet Scenarios (#676, #675, #674, #673)", () => {
  describe("Scenario #676: Amounts outside the anchor's limits", () => {
    it("refuses amounts below minimum before settle (0 money moved)", async () => {
      const submitter = makeTrackingSubmitter();
      const c = testCorridor();
      const mockInfoAdapter = {
        async getInfo() {
          return ok({
            receive: {
              [c.settlement.bridge_asset]: {
                minAmount: "1.00",
                maxAmount: "1000.00",
              },
            },
          });
        },
      };

      const deps: EngineDeps = {
        resolver: new StaticRouteResolver(() => createMockAdapter(), {
          trustManifestWithoutAttestation: true,
        }),
        submitter,
        gate: defaultSep31Gate({ checks: [amountRangeCheck(mockInfoAdapter)] }),
        idempotency: new InMemoryIdempotencyStore(),
        trustManifestWithoutAttestation: true,
      };

      const result = await execute(makeIntent("limits-below", "0.50"), c, deps);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("PRESETTLE_AMOUNT_OUT_OF_RANGE");
        expect(result.error.message).toContain("below minimum 1");
      }
      expect(submitter.submitCalls).toBe(0);
    });

    it("refuses amounts above maximum before settle (0 money moved)", async () => {
      const submitter = makeTrackingSubmitter();
      const c = testCorridor();
      const mockInfoAdapter = {
        async getInfo() {
          return ok({
            receive: {
              [c.settlement.bridge_asset]: {
                minAmount: "1.00",
                maxAmount: "500.00",
              },
            },
          });
        },
      };

      const deps: EngineDeps = {
        resolver: new StaticRouteResolver(() => createMockAdapter(), {
          trustManifestWithoutAttestation: true,
        }),
        submitter,
        gate: defaultSep31Gate({ checks: [amountRangeCheck(mockInfoAdapter)] }),
        idempotency: new InMemoryIdempotencyStore(),
        trustManifestWithoutAttestation: true,
        unprovenMaxAmount: "10000.00",
      };

      const result = await execute(makeIntent("limits-above", "600.00"), c, deps);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("PRESETTLE_AMOUNT_OUT_OF_RANGE");
        expect(result.error.message).toContain("above maximum 500");
      }
      expect(submitter.submitCalls).toBe(0);
    });
  });

  describe("Scenario #673: Anchor asks for more customer information (NEEDS_INFO)", () => {
    it("halts cleanly with PRESETTLE_RECEIVER_NOT_ACCEPTED before settle (0 money moved)", async () => {
      const submitter = makeTrackingSubmitter();
      const mockAdapter: AnchorAdapter = {
        ...createMockAdapter({ kyc: "accepted" }),
      };

      // Mock receiver KYC adapter for pre-settle check returning pending (NEEDS_INFO)
      const mockKycAdapter: ReceiverKycAdapterLike = {
        async ensureCompliance(): Promise<Outcome<KycResult>> {
          return ok({ status: "pending", customerId: "cust-needs-info" });
        },
      };

      const c = testCorridor();
      const deps: EngineDeps = {
        resolver: new StaticRouteResolver(() => mockAdapter, {
          trustManifestWithoutAttestation: true,
        }),
        submitter,
        gate: defaultSep31Gate({ checks: [receiverKycCheck(mockKycAdapter)] }),
        idempotency: new InMemoryIdempotencyStore(),
        trustManifestWithoutAttestation: true,
      };

      const result = await execute(makeIntent("needs-info-1", "10.00"), c, deps);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("PRESETTLE_RECEIVER_NOT_ACCEPTED");
      }
      expect(submitter.submitCalls).toBe(0);
    });
  });

  describe("Scenario #675: Anchor down during the flow", () => {
    it("fails cleanly without moving money when anchor is down", async () => {
      const submitter = makeTrackingSubmitter();
      const failingAdapter: AnchorAdapter = {
        ...createMockAdapter(),
        async requestQuote() {
          return fail("ANCHOR_UNAVAILABLE", "Connection refused: anchor is down", {
            retryable: true,
          });
        },
      };

      const c = testCorridor();
      const deps: EngineDeps = {
        resolver: new StaticRouteResolver(() => failingAdapter, {
          trustManifestWithoutAttestation: true,
        }),
        submitter,
        gate: defaultSep31Gate(),
        idempotency: new InMemoryIdempotencyStore(),
        trustManifestWithoutAttestation: true,
      };

      const result = await execute(makeIntent("outage-test", "10.00"), c, deps);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("ANCHOR_UNAVAILABLE");
      }
      expect(submitter.submitCalls).toBe(0);
    });

    it("resumes safely after recovery without double settlement", async () => {
      const submitter = makeTrackingSubmitter();
      const store = new InMemoryIdempotencyStore();
      const c = testCorridor();

      // First run succeeds
      const adapter = createMockAdapter({ settled: true });
      const deps: EngineDeps = {
        resolver: new StaticRouteResolver(() => adapter, {
          trustManifestWithoutAttestation: true,
        }),
        submitter,
        gate: defaultSep31Gate(),
        idempotency: store,
        trustManifestWithoutAttestation: true,
      };

      const intent = makeIntent("idemp-recovery-1", "10.00");
      const result1 = await execute(intent, c, deps);
      expect(result1.ok).toBe(true);
      expect(submitter.submitCalls).toBe(1);

      // Replay / retry with same idempotency key must not re-settle (idempotency guard)
      const result2 = await execute(intent, c, deps);
      expect(submitter.submitCalls).toBe(1); // Never double settled
      expect(result2.ok).toBe(true);
    });
  });

  describe("Scenario #674: Payout fails and anchor refunds", () => {
    it("transitions recovering -> refunded with exactly 1 on-chain settlement", async () => {
      const submitter = makeTrackingSubmitter();
      const store = new InMemoryIdempotencyStore();
      const audit = new InMemoryAuditLog();

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

      const c = testCorridor();
      const deps: EngineDeps = {
        resolver: new StaticRouteResolver(() => adapter, {
          trustManifestWithoutAttestation: true,
        }),
        submitter,
        idempotency: store,
        audit,
        trustManifestWithoutAttestation: true,
        unsafeSkipPreSettleGate: true,
      };

      const intent = makeIntent("refund-test-1", "10.00");
      const result = await execute(intent, c, deps);

      expect(result.ok).toBe(false);
      const stored = await store.get("refund-test-1");
      expect(stored?.state).toBe("refunded");
      expect(submitter.submitCalls).toBe(1); // Exactly 1 settlement move

      // Audit trail must record recovering -> refunded
      const trail = audit.entries.map((e) => e.to);
      expect(trail).toContain("recovering");
      expect(trail).toContain("refunded");
    });
  });
});
