// Wallet route trustline checking before sending funds (#648, RFC 0004).
//
// A USDC payment to an account with no USDC trustline fails on chain, incurring fees
// and stranding transactions. This module verifies that the recipient account exists
// and possesses an authorized trustline for the bridge/payout asset prior to settlement.

import type { AccountFacts, AccountInspectorLike } from "./index";

export type WalletTrustlineRefusalCode =
  "ACCOUNT_NOT_FOUND" | "TRUSTLINE_MISSING" | "TRUSTLINE_UNAUTHORIZED";

export interface WalletTrustlineCheckResult {
  readonly ok: boolean;
  readonly code?: WalletTrustlineRefusalCode;
  readonly reason: string;
  readonly account?: AccountFacts;
}

export interface CheckWalletTrustlineOptions {
  /** Optional asset issuer account ID to verify exact issuer match. */
  readonly assetIssuer?: string;
}

/**
 * Verifies that a recipient Stellar wallet account exists and possesses an authorized
 * trustline for the given asset before funds are broadcast on chain.
 */
export async function checkWalletRecipientTrustline(
  inspector: AccountInspectorLike,
  recipientAddress: string,
  assetCode: string,
  options: CheckWalletTrustlineOptions = {},
): Promise<WalletTrustlineCheckResult> {
  const codeUpper = assetCode.toUpperCase();
  const isNative = codeUpper === "XLM" || assetCode.toLowerCase() === "native";

  let facts: AccountFacts | undefined;
  try {
    if ("account" in inspector && typeof inspector.account === "function") {
      const outcome = await inspector.account(recipientAddress);
      if (!outcome.ok) {
        return {
          ok: false,
          code: "ACCOUNT_NOT_FOUND",
          reason: `recipient account inspection failed: ${outcome.error.message}`,
        };
      }
      facts = outcome.value;
    } else if ("loadAccount" in inspector && typeof inspector.loadAccount === "function") {
      const res = await inspector.loadAccount(recipientAddress);
      facts = {
        id: res.id ?? recipientAddress,
        subentry_count: res.subentry_count ?? 0,
        num_sponsoring: res.num_sponsoring ?? 0,
        num_sponsored: res.num_sponsored ?? 0,
        balances: (res.balances ?? []).map((b) => ({
          asset_type: b.asset_type,
          asset_code: b.asset_code,
          asset_issuer: b.asset_issuer,
          balance: b.balance,
          selling_liabilities: b.selling_liabilities ?? "0",
          buying_liabilities: b.buying_liabilities ?? "0",
          is_authorized: b.is_authorized ?? true,
        })),
        flags: res.flags,
      };
    } else {
      return {
        ok: false,
        code: "ACCOUNT_NOT_FOUND",
        reason: "invalid AccountInspector instance",
      };
    }
  } catch (err: unknown) {
    const anyErr = err as {
      response?: { status?: number };
      status?: number;
      message?: string;
    };
    if (
      anyErr?.response?.status === 404 ||
      anyErr?.status === 404 ||
      /not found/i.test(anyErr?.message ?? "")
    ) {
      facts = undefined;
    } else {
      return {
        ok: false,
        code: "ACCOUNT_NOT_FOUND",
        reason: `recipient account inspection error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (!facts) {
    return {
      ok: false,
      code: "ACCOUNT_NOT_FOUND",
      reason: "recipient account does not exist on-chain",
    };
  }

  // Native XLM does not require a trustline
  if (isNative) {
    return {
      ok: true,
      reason: "recipient account exists; native XLM requires no trustline",
      account: facts,
    };
  }

  // Search for the asset trustline among account balances
  const targetIssuer = options.assetIssuer;
  const trustline = facts.balances.find((b) => {
    if (b.asset_type === "native") return false;
    if (b.asset_code?.toUpperCase() !== codeUpper) return false;
    if (targetIssuer && b.asset_issuer && b.asset_issuer !== targetIssuer) {
      return false;
    }
    return true;
  });

  if (!trustline) {
    return {
      ok: false,
      code: "TRUSTLINE_MISSING",
      reason: `recipient account lacks a trustline for ${codeUpper}`,
      account: facts,
    };
  }

  if (trustline.is_authorized === false) {
    return {
      ok: false,
      code: "TRUSTLINE_UNAUTHORIZED",
      reason: `recipient trustline for ${codeUpper} is not authorized`,
      account: facts,
    };
  }

  return {
    ok: true,
    reason: `recipient account exists with an authorized ${codeUpper} trustline`,
    account: facts,
  };
}
