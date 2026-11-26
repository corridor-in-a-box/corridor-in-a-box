import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { fail, ok, type PaymentIntent, type SettlementRef } from "@corridor/types";
import type { SettlementRequest, SettlementSubmitter } from "@corridor/engine";
import { WalletAdapter } from "@corridor/stellar";

const ACCOUNT = Keypair.random().publicKey();
const TX_HASH = "a".repeat(64);
const ISSUER = Keypair.random().publicKey();

const walletCorridor = {
  id: "wallet-usdc",
  source: { name: "Sending business", asset: "USDC", endpoints: { home_domain: "s.example" } },
  dest: {
    protocol: "wallet",
    name: "Recipient wallet",
    asset: "USDC",
    asset_issuer: ISSUER,
    endpoints: { home_domain: "wallet.example" },
  },
  fx: { path: ["USD", "USDC", "USD"], who_holds_risk: "sender" },
  compliance: { source_jurisdiction: "US", dest_jurisdiction: "US" },
  settlement: { network: "testnet", asset_issuer: ISSUER, bridge_asset: "USDC" },
  recovery: {},
};

function corridorOf(raw: Record<string, unknown> = walletCorridor): Corridor {
  const r = parseCorridor(raw);
  if (!r.ok) throw new Error(`fixture did not parse: ${r.error.message}`);
  return r.value;
}

function intentFor(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    idempotencyKey: "wallet-payment-1",
    corridorId: "wallet-usdc",
    sender: { id: "sender-1" },
    recipient: { id: "recipient-1" },
    sourceAmount: { asset: "USDC", amount: "10.00" },
    wallet: { account: ACCOUNT },
    ...overrides,
  };
}

function stubSubmitter(opts: { failSubmit?: boolean } = {}) {
  const calls: SettlementRequest[] = [];
  const ref: SettlementRef = {
    kind: "stellar",
    stellarTxHash: TX_HASH,
    ledger: 12345,
    feeCharged: "100",
  };
  const submitter: SettlementSubmitter = {
    async submit(req) {
      calls.push(req);
      return opts.failSubmit
        ? fail("SETTLEMENT_FAILED", "stub: submit failed", { retryable: false })
        : ok(ref);
    },
    async refund() {
      return fail("REFUND_UNSUPPORTED", "stub: no refunds");
    },
  };
  return { submitter, calls, ref };
}

function open(adapter: WalletAdapter, intent = intentFor(), corridor = corridorOf()) {
  return adapter.openTransaction(
    intent,
    {
      id: "q1",
      price: "1",
      expiresAt: 0,
      sourceAmount: intent.sourceAmount,
      destAmount: intent.sourceAmount,
      firm: false,
    },
    corridor,
  );
}

describe("WalletAdapter (#647)", () => {
  it("declares adapter-led settlement and no anchor KYC", () => {
    const { submitter } = stubSubmitter();
    const adapter = new WalletAdapter(corridorOf(), { submitter });
    expect(adapter.capabilities()).toMatchObject({
      protocol: "wallet",
      quotes: ["native"],
      kyc: "none",
      settlement: ["adapter_settled"],
      refunds: "none",
    });
  });

  it("quotes 1:1 in the corridor's declared asset", async () => {
    const { submitter } = stubSubmitter();
    const adapter = new WalletAdapter(corridorOf(), { submitter });
    const q = await adapter.requestQuote(intentFor(), corridorOf());
    expect(q.ok).toBe(true);
    if (q.ok) {
      expect(q.value.price).toBe("1");
      expect(q.value.firm).toBe(false);
      expect(q.value.destAmount).toEqual({ asset: "USDC", amount: "10.00" });
    }
  });

  it("opens an adapter-settled payment to the recipient's account", async () => {
    const { submitter } = stubSubmitter();
    const adapter = new WalletAdapter(corridorOf(), { submitter });
    const opened = await open(adapter);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.value.transactionId).toBe("wallet:wallet-payment-1");
      expect(opened.value.instructions.kind).toBe("adapter_settled");
      expect(opened.value.amountIn).toEqual({ asset: "USDC", amount: "10.00" });
    }
  });

  it("reports completion only once the submitter confirms the payment", async () => {
    const { submitter, calls, ref } = stubSubmitter();
    const adapter = new WalletAdapter(corridorOf(), { submitter });
    const intent = intentFor({
      wallet: { account: ACCOUNT, memo: "invoice-7", memoType: "text" },
    });
    const opened = await open(adapter, intent);
    if (!opened.ok) throw new Error(opened.error.message);

    const before = await adapter.getTransaction(opened.value.transactionId);
    expect(before.ok && before.value.settled).toBe(false);

    const confirmed = await adapter.confirmSettlement(opened.value.transactionId);
    expect(confirmed.ok).toBe(true);
    if (confirmed.ok) expect(confirmed.value).toEqual(ref);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      to: ACCOUNT,
      memo: "invoice-7",
      memoType: "text",
      amount: { asset: "USDC", amount: "10.00" },
    });

    const after = await adapter.getTransaction(opened.value.transactionId);
    expect(after.ok && after.value).toMatchObject({ status: "completed", settled: true });
  });

  it("is idempotent per transaction: a resumed run submits once", async () => {
    const { submitter, calls } = stubSubmitter();
    const adapter = new WalletAdapter(corridorOf(), { submitter });
    const opened = await open(adapter);
    if (!opened.ok) throw new Error(opened.error.message);

    const [a, b] = await Promise.all([
      adapter.confirmSettlement(opened.value.transactionId),
      adapter.confirmSettlement(opened.value.transactionId),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("stays incomplete when the submitter fails, and moves no state", async () => {
    const { submitter } = stubSubmitter({ failSubmit: true });
    const adapter = new WalletAdapter(corridorOf(), { submitter });
    const opened = await open(adapter);
    if (!opened.ok) throw new Error(opened.error.message);

    const confirmed = await adapter.confirmSettlement(opened.value.transactionId);
    expect(confirmed.ok).toBe(false);
    const status = await adapter.getTransaction(opened.value.transactionId);
    expect(status.ok && status.value.settled).toBe(false);
  });

  it("refuses a payment with no recipient wallet, before contacting the submitter", async () => {
    const { submitter, calls } = stubSubmitter();
    const adapter = new WalletAdapter(corridorOf(), { submitter });
    const { wallet, ...withoutWallet } = intentFor();
    void wallet;
    const opened = await open(adapter, withoutWallet as PaymentIntent);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.code).toBe("PRESETTLE_DESTINATION_UNSAFE");
    expect(calls).toHaveLength(0);
  });

  it("refuses a malformed recipient account", async () => {
    const { submitter } = stubSubmitter();
    const adapter = new WalletAdapter(corridorOf(), { submitter });
    const opened = await open(adapter, intentFor({ wallet: { account: "not-an-account" } }));
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error.code).toBe("PRESETTLE_DESTINATION_UNSAFE");
      expect(opened.error.message).toContain("Stellar");
    }
  });

  it("refuses a memo that cannot be encoded on-chain", async () => {
    const { submitter } = stubSubmitter();
    const adapter = new WalletAdapter(corridorOf(), { submitter });
    const opened = await open(
      adapter,
      intentFor({ wallet: { account: ACCOUNT, memo: "x".repeat(29), memoType: "text" } }),
    );
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.message).toContain("28 bytes");
  });

  it("refuses to refund a payment that went straight to the recipient", async () => {
    const { submitter } = stubSubmitter();
    const adapter = new WalletAdapter(corridorOf(), { submitter });
    const refund = await adapter.requestRefund(
      "wallet:wallet-payment-1",
      { asset: "USDC", amount: "10.00" },
      "requested by sender",
    );
    expect(refund.ok).toBe(false);
    if (!refund.ok) expect(refund.error.code).toBe("REFUND_UNSUPPORTED");
  });

  it("fails closed on an unknown wallet transaction", async () => {
    const { submitter } = stubSubmitter();
    const adapter = new WalletAdapter(corridorOf(), { submitter });
    const status = await adapter.getTransaction("wallet:never-opened");
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.error.code).toBe("RECONCILE_MISMATCH");
  });

  it("refuses a corridor that would need an FX conversion", () => {
    const { submitter } = stubSubmitter();
    const corridor = corridorOf({
      ...walletCorridor,
      dest: { ...walletCorridor.dest, asset: "EURC" },
    });
    expect(() => new WalletAdapter(corridor, { submitter })).toThrow(/cannot convert/);
  });

  it("refuses a corridor whose dest.asset_issuer differs from the settlement issuer", () => {
    const { submitter } = stubSubmitter();
    const corridor = corridorOf({
      ...walletCorridor,
      dest: { ...walletCorridor.dest, asset_issuer: Keypair.random().publicKey() },
    });
    expect(() => new WalletAdapter(corridor, { submitter })).toThrow(/cannot convert/);
  });

  it("refuses a corridor whose dest protocol is not wallet", () => {
    const { submitter } = stubSubmitter();
    const corridor = corridorOf({
      ...walletCorridor,
      dest: {
        name: "Anchor",
        asset: "USDC",
        protocol: "sep31",
        endpoints: { home_domain: "anchor.example", base_url: "https://anchor.example/sep31" },
      },
    });
    expect(() => new WalletAdapter(corridor, { submitter })).toThrow(/cannot handle protocol/);
  });
});
