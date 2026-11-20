import { describe, expect, it, vi } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter, type Quote } from "@corridor/adapter-kit";
import { StaticRouteResolver } from "@corridor/router";
import {
  createMockSubmitter,
  execute,
  InMemoryAuditLog,
  InMemoryIdempotencyStore,
  type EngineDeps,
} from "@corridor/engine";
import type { PaymentIntent } from "@corridor/types";

function corridor(): Corridor {
  const r = parseCorridor({
    id: "test",
    source: {
      name: "S",
      asset: "USDC",
      protocol: "prefunded",
      endpoints: { home_domain: "s.example" },
    },
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
    settlement: {
      bridge_asset: "USDC",
      network: "testnet",
      anchor_domain: "d.example",
      asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    },
    recovery: { max_retries: 3, timeout_seconds: 60, refund_wait_seconds: 60 },
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const INTENT: PaymentIntent = {
  idempotencyKey: "supplied-quote-test-1",
  corridorId: "test",
  sender: { id: "sender_1" },
  recipient: { id: "recip_1" },
  sourceAmount: { asset: "USDC", amount: "5.00" },
};

describe("execute with supplied quote (#622)", () => {
  it("uses the pre-fetched quote as-is without calling adapter requestQuote", async () => {
    const adapter = createMockAdapter();
    const requestQuoteSpy = vi.spyOn(adapter, "requestQuote");
    const audit = new InMemoryAuditLog();

    const suppliedQuote: Quote = {
      id: "pre-fetched-quote-123",
      sourceAmount: { asset: "USDC", amount: "5.00" },
      destAmount: { asset: "iso4217:ARS", amount: "6250.00" },
      price: "1250.00",
      expiresAt: Date.now() + 100_000,
      firm: true,
    };

    const deps: EngineDeps = {
      resolver: new StaticRouteResolver(() => adapter, {
        trustManifestWithoutAttestation: true,
      }),
      idempotency: new InMemoryIdempotencyStore(),
      audit,
      submitter: createMockSubmitter(),
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };

    const res = await execute(INTENT, corridor(), deps, {
      quote: suppliedQuote,
    });

    expect(res.ok).toBe(true);
    // Adapter's requestQuote was never called
    expect(requestQuoteSpy).not.toHaveBeenCalled();

    // Audit trail records quoteSupplied on the transition into 'quoted'
    const quotedEntry = audit.entries.find((e) => e.to === "quoted");
    expect(quotedEntry).toBeDefined();
    expect(quotedEntry?.quoteSupplied).toBe(true);
  });

  it("requests quote from adapter as usual when quote option is omitted", async () => {
    const adapter = createMockAdapter();
    const requestQuoteSpy = vi.spyOn(adapter, "requestQuote");
    const audit = new InMemoryAuditLog();

    const deps: EngineDeps = {
      resolver: new StaticRouteResolver(() => adapter, {
        trustManifestWithoutAttestation: true,
      }),
      idempotency: new InMemoryIdempotencyStore(),
      audit,
      submitter: createMockSubmitter(),
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };

    const res = await execute(
      { ...INTENT, idempotencyKey: "absent-quote-test-2" },
      corridor(),
      deps,
    );

    expect(res.ok).toBe(true);
    expect(requestQuoteSpy).toHaveBeenCalledTimes(1);

    const quotedEntry = audit.entries.find((e) => e.to === "quoted");
    expect(quotedEntry).toBeDefined();
    expect(quotedEntry?.quoteSupplied).toBeUndefined();
  });
});
