// The wallet route's adapter (RFC 0004 §5): a plain Stellar payment to the
// recipient's own account. No receiving anchor is involved and nothing is
// converted — the corridor's bridge asset is delivered as-is, and the recipient
// cashes out afterwards on their own. The engine never drives SEP-24.
//
// Settlement is adapter-led: `openTransaction()` only records the recipient and
// amount, so no money moves before the engine's pre-settle gate has run.
// `confirmSettlement()` then submits the payment through an injected
// `SettlementSubmitter` — `StellarSettlementSubmitter` in production, a stub in
// tests — and returns its ref only after Horizon has confirmed the ledger.
// `getTransaction()` reports `completed` once that confirmation is stored.

import { StrKey } from "@stellar/stellar-sdk";
import type { Corridor } from "@corridor/manifest";
import type {
  AdapterCapabilities,
  AnchorAdapter,
  KycResult,
  OpenTransaction,
  Quote,
  RefundRef,
  TransactionStatus,
} from "@corridor/adapter-kit";
import {
  fail,
  ok,
  type Money,
  type Outcome,
  type PaymentIntent,
  type SettlementRef,
  type WalletDestination,
} from "@corridor/types";
import type { SettlementRequest, SettlementSubmitter } from "@corridor/engine";

export interface WalletAdapterOptions {
  /**
   * Moves the money: the same port the engine uses for an anchor deposit, so
   * `StellarSettlementSubmitter` (or a KMS-backed variant) is the production
   * implementation and a stub is all a test needs.
   */
  readonly submitter: SettlementSubmitter;
  /** Injectable clock for the quote window; defaults to `Date.now`. */
  readonly now?: () => number;
}

const MAX_MEMO_TEXT_BYTES = 28;
const MAX_UINT64 = 2n ** 64n - 1n;

/** Why this memo cannot be encoded on-chain, or null when it can. */
function memoProblem(destination: WalletDestination): string | null {
  if (destination.memo === undefined) {
    return destination.memoType === undefined
      ? null
      : `wallet.memoType is "${destination.memoType}" but wallet.memo is missing`;
  }
  switch (destination.memoType ?? "text") {
    case "text":
      return Buffer.byteLength(destination.memo, "utf8") > MAX_MEMO_TEXT_BYTES
        ? `wallet.memo is longer than ${MAX_MEMO_TEXT_BYTES} bytes for a text memo`
        : null;
    case "id":
      return /^\d+$/.test(destination.memo) && BigInt(destination.memo) <= MAX_UINT64
        ? null
        : 'wallet.memo must be an unsigned 64-bit integer string for memoType "id"';
    case "hash":
      return Buffer.from(destination.memo, "base64").length === 32
        ? null
        : 'wallet.memo must be 32 bytes of base64 for memoType "hash"';
  }
}

/**
 * Receiving adapter for `protocol: wallet` corridors. It implements the same
 * `AnchorAdapter` seam the anchor protocols do, so routing, gating, idempotency
 * and reconciliation are unchanged; only the settlement step differs.
 */
export class WalletAdapter implements AnchorAdapter {
  readonly name: string;
  private readonly corridor: Corridor;
  private readonly submitter: SettlementSubmitter;
  private readonly now: () => number;
  /** Payments opened but not yet submitted, keyed by transaction id. */
  private readonly opened = new Map<string, SettlementRequest>();
  /** Settlements the submitter confirmed, keyed by transaction id. */
  private readonly settled = new Map<string, SettlementRef>();
  /** Submissions in flight, so two concurrent confirms cannot both pay. */
  private readonly submitting = new Map<string, Promise<Outcome<SettlementRef>>>();

  constructor(corridor: Corridor, opts: WalletAdapterOptions) {
    if (corridor.dest.protocol !== "wallet") {
      throw new Error(
        `WalletAdapter cannot handle protocol "${corridor.dest.protocol}"; use an adapter for that protocol`,
      );
    }
    const bridge = corridor.settlement.bridge_asset;
    if (corridor.dest.asset.toUpperCase() !== bridge.toUpperCase()) {
      throw new Error(
        `WalletAdapter: corridor ${corridor.id} delivers "${corridor.dest.asset}" but settles ` +
          `"${bridge}" — a wallet route pays the recipient directly and cannot convert assets`,
      );
    }
    // The submitter pays with `settlement.asset_issuer`, so a different
    // `dest.asset_issuer` would deliver an asset the corridor does not declare.
    const destIssuer =
      "asset_issuer" in corridor.dest
        ? (corridor.dest.asset_issuer as string | undefined)
        : undefined;
    if (
      destIssuer !== undefined &&
      bridge.toUpperCase() !== "XLM" &&
      destIssuer !== corridor.settlement.asset_issuer
    ) {
      throw new Error(
        `WalletAdapter: corridor ${corridor.id} declares dest.asset_issuer ${destIssuer} but ` +
          `settles with ${corridor.settlement.asset_issuer} — a wallet route cannot convert assets`,
      );
    }
    this.name = corridor.dest.name;
    this.corridor = corridor;
    this.submitter = opts.submitter;
    this.now = opts.now ?? (() => Date.now());
  }

  capabilities(): AdapterCapabilities {
    return {
      protocol: "wallet",
      quotes: ["native"],
      kyc: "none",
      // The recipient is paid on-chain by this adapter; there is no anchor
      // deposit account, so the engine must not also submit a payment.
      settlement: ["adapter_settled"],
      refunds: "none",
      callbacks: false,
    };
  }

  /**
   * Deliver the same amount in the declared asset: a wallet route has no FX.
   * The quote is non-firm because nothing here promises a rate — there is no
   * rate to lock.
   */
  async requestQuote(intent: PaymentIntent, corridor: Corridor): Promise<Outcome<Quote>> {
    const amount = intent.sourceAmount.amount;
    return ok<Quote>({
      id: `wallet:${corridor.id}:${intent.idempotencyKey}`,
      price: "1",
      expiresAt: this.now() + corridor.fx.quote_ttl_seconds * 1000,
      sourceAmount: { asset: intent.sourceAmount.asset, amount },
      destAmount: { asset: corridor.dest.asset, amount },
      firm: false,
    });
  }

  /** No anchor KYC: the recipient is the account that receives the payment. */
  async ensureCompliance(
    _intent: PaymentIntent,
    _corridor: Corridor,
  ): Promise<Outcome<KycResult>> {
    return ok<KycResult>({ status: "accepted" });
  }

  /**
   * Record where the payment goes. Deliberately moves no money: the engine runs
   * its pre-settle gate between open and settle.
   */
  async openTransaction(
    intent: PaymentIntent,
    quote: Quote,
    corridor: Corridor,
  ): Promise<Outcome<OpenTransaction>> {
    const destination = intent.wallet;
    if (!destination) {
      return fail(
        "PRESETTLE_DESTINATION_UNSAFE",
        `${this.name}: a wallet corridor needs intent.wallet { account, memo?, memoType? } — ` +
          `there is no anchor payout record to deliver to`,
      );
    }
    if (!StrKey.isValidEd25519PublicKey(destination.account)) {
      return fail(
        "PRESETTLE_DESTINATION_UNSAFE",
        `${this.name}: intent.wallet.account "${destination.account}" is not a valid Stellar ` +
          `account address (G...)`,
      );
    }
    const problem = memoProblem(destination);
    if (problem) {
      return fail("PRESETTLE_DESTINATION_UNSAFE", `${this.name}: ${problem}`);
    }

    const transactionId = `wallet:${intent.idempotencyKey}`;
    const request: SettlementRequest = {
      to: destination.account,
      ...(destination.memo !== undefined ? { memo: destination.memo } : {}),
      ...(destination.memoType !== undefined ? { memoType: destination.memoType } : {}),
      amount: { asset: corridor.settlement.bridge_asset, amount: quote.sourceAmount.amount },
      corridor,
      ...(quote.firm ? { validUntil: quote.expiresAt } : {}),
    };
    this.opened.set(transactionId, request);

    return ok<OpenTransaction>({
      transactionId,
      instructions: { kind: "adapter_settled" },
      amountIn: request.amount,
    });
  }

  /**
   * Submit the recipient payment and return its ref once the submitter has
   * confirmed it on the ledger. Idempotent per transaction: a resumed run
   * reuses the ref, and a submitter that can find an existing payment is asked
   * before a new one is sent.
   */
  async confirmSettlement(transactionId: string): Promise<Outcome<SettlementRef>> {
    const already = this.settled.get(transactionId);
    if (already) return ok(already);

    const inFlight = this.submitting.get(transactionId);
    if (inFlight) return inFlight;

    const pending = this.submitOnce(transactionId);
    this.submitting.set(transactionId, pending);
    try {
      return await pending;
    } finally {
      this.submitting.delete(transactionId);
    }
  }

  private async submitOnce(transactionId: string): Promise<Outcome<SettlementRef>> {
    const request = this.opened.get(transactionId);
    if (!request) {
      return fail(
        "SETTLEMENT_FAILED",
        `${this.name}: no opened wallet payment for transaction ${transactionId} — ` +
          `call openTransaction first`,
        { retryable: false },
      );
    }

    if (this.submitter.findExisting) {
      const existing = await this.submitter.findExisting(request);
      if (!existing.ok) return existing;
      if (existing.value) {
        this.settled.set(transactionId, existing.value);
        return ok(existing.value);
      }
    }

    const submitted = await this.submitter.submit(request);
    if (!submitted.ok) return submitted;
    this.settled.set(transactionId, submitted.value);
    return submitted;
  }

  /**
   * A wallet payment is complete exactly when its settlement is confirmed on
   * the ledger. Until then it is in flight; an unknown id is a mismatch rather
   * than an invitation to keep polling.
   */
  async getTransaction(transactionId: string): Promise<Outcome<TransactionStatus>> {
    if (this.settled.has(transactionId)) {
      return ok<TransactionStatus>({ status: "completed", settled: true });
    }
    if (this.opened.has(transactionId)) {
      return ok<TransactionStatus>({
        status: "pending_external",
        phase: "external",
        settled: false,
      });
    }
    return fail(
      "RECONCILE_MISMATCH",
      `${this.name}: no wallet payment with transaction id ${transactionId}`,
      { retryable: false },
    );
  }

  /** A plain payment to the recipient cannot be reversed unilaterally. */
  async requestRefund(
    transactionId: string,
    _amount: Money,
    _reason: string,
  ): Promise<Outcome<RefundRef>> {
    return fail(
      "REFUND_UNSUPPORTED",
      `${this.name}: wallet payment ${transactionId} went straight to the recipient's account; ` +
        `there is no anchor to request a refund from`,
      { retryable: false },
    );
  }
}
