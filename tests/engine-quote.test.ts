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

function deps(
  adapter: ReturnType<typeof createMockAdapter>,
  audit: InMemoryAuditLog,
  submitter: ReturnType<typeof createMockSubmitter>,
): EngineDeps {
  return {
    resolver: new StaticRouteResolver(() => adapter, {
      trustManifestWithoutAttestation: true,
    }),
    idempotency: new InMemoryIdempotencyStore(),
    audit,
    submitter,
    trustManifestWithoutAttestation: true,
    unsafeSkipPreSettleGate: true,
  };
}

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
  it("hands the supplied quote itself to the anchor and settles its exact amount", async () => {
    const adapter = createMockAdapter();
    const openSpy = vi.spyOn(adapter, "openTransaction");
    const submitter = createMockSubmitter();
    const submitSpy = vi.spyOn(submitter, "submit");
    const suppliedQuote: Quote = {
      id: "locked-as-is",
      sourceAmount: { asset: "USDC", amount: "5.00" },
      destAmount: { asset: "iso4217:ARS", amount: "6250.123" },
      price: "1250.0246",
      expiresAt: Date.now() + 100_000,
      firm: true,
    };
    const res = await execute(
      { ...INTENT, idempotencyKey: "as-is-3" },
      corridor(),
      deps(adapter, new InMemoryAuditLog(), submitter),
      { quote: suppliedQuote },
    );
    expect(res.ok).toBe(true);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy.mock.calls[0]![1]).toBe(suppliedQuote);
    expect(submitSpy.mock.calls[0]![0].amount).toEqual({ asset: "USDC", amount: "5.00" });
  });

  it.each([
    [
      "another source asset",
      { sourceAmount: { asset: "EURC", amount: "5.00" } },
      /source asset EURC/,
    ],
    [
      "another source amount",
      { sourceAmount: { asset: "USDC", amount: "500" } },
      /source amount 500/,
    ],
    ["no price", { price: "0" }, /no positive price/],
    ["no expiry", { expiresAt: Number.NaN }, /no valid expiresAt/],
  ])(
    "refuses a supplied quote for %s without re-quoting or settling",
    async (_name, over, msg) => {
      const adapter = createMockAdapter();
      const requestQuoteSpy = vi.spyOn(adapter, "requestQuote");
      const submitter = createMockSubmitter();
      const submitSpy = vi.spyOn(submitter, "submit");
      const bad = {
        id: "bad-quote",
        sourceAmount: { asset: "USDC", amount: "5.00" },
        destAmount: { asset: "iso4217:ARS", amount: "6250.00" },
        price: "1250.00",
        expiresAt: Date.now() + 100_000,
        firm: true,
        ...over,
      } as Quote;
      const res = await execute(
        { ...INTENT, idempotencyKey: `bad-${_name}` },
        corridor(),
        deps(adapter, new InMemoryAuditLog(), submitter),
        { quote: bad },
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("QUOTE_UNAVAILABLE");
        expect(res.error.retryable).toBe(false);
        expect(res.error.message).toMatch(msg);
      }
      expect(requestQuoteSpy).not.toHaveBeenCalled();
      expect(submitSpy).not.toHaveBeenCalled();
    },
  );

  it("accepts the same amount written differently", async () => {
    const adapter = createMockAdapter();
    const res = await execute(
      { ...INTENT, idempotencyKey: "same-amount-4" },
      corridor(),
      deps(adapter, new InMemoryAuditLog(), createMockSubmitter()),
      {
        quote: {
          id: "q-5",
          sourceAmount: { asset: "USDC", amount: "5" },
          destAmount: { asset: "iso4217:ARS", amount: "6250" },
          price: "1250",
          expiresAt: Date.now() + 100_000,
          firm: true,
        },
      },
    );
    expect(res.ok).toBe(true);
  });
});
