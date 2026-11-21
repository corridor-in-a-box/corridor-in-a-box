// @corridor/probe — Lane check v1: authorised GET /sep31/info probe.
//
// Some receivers accept the SEP-10 login (issuing a JWT) but refuse at the
// SEP-31 layer (rejecting the JWT, returning 401/403, or disabling the receive
// bridge asset). Calling /sep31/info with the JWT is a cheap second check.
//
// Acceptance contract:
// - Open only when both steps pass (sep10_auth AND sep31_info).
// - The result says which step failed (failedStep: "sep10_auth" | "sep31_info").

import { Keypair, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { isSafeUrl } from "./url-safety";
import { tomlValue } from "./index";

export type LaneCheckStep = "sep10_auth" | "sep31_info";

export interface LaneCheckStepResult {
  readonly step: LaneCheckStep;
  readonly passed: boolean;
  readonly detail: string;
  readonly error?: string;
}

export interface LaneCheckResult {
  /** True only when both sep10_auth and sep31_info steps pass. */
  readonly open: boolean;
  /** Which step failed when open is false: 'sep10_auth' or 'sep31_info'. */
  readonly failedStep?: LaneCheckStep;
  /** Which step failed (alias for failedStep when open is false, or last step executed). */
  readonly step?: LaneCheckStep;
  /** List of steps that passed successfully. */
  readonly passedSteps: readonly LaneCheckStep[];
  /** Detailed result for each attempted step. */
  readonly steps: readonly LaneCheckStepResult[];
  /** Human-readable explanation of outcome. */
  readonly detail: string;
  /** Error message if any step failed. */
  readonly error?: string;
  /** JWT token acquired from SEP-10 if step 1 passed. */
  readonly token?: string;
  /** Receive assets accepted by anchor from SEP-31 info if step 2 passed. */
  readonly receiveAssets?: readonly string[];
}

export interface LaneCheckTarget {
  readonly webAuth?: string;
  readonly transferServerSep31?: string;
  readonly directPaymentServer?: string;
  readonly homeDomain?: string;
  readonly domain?: string;
  readonly bridgeAsset?: string;
  readonly asset?: string;
  readonly endpoints?: {
    readonly web_auth?: string;
    readonly transfer_server_sep31?: string;
    readonly home_domain?: string;
  };
  readonly dest?: {
    readonly endpoints: {
      readonly web_auth?: string;
      readonly transfer_server_sep31?: string;
      readonly home_domain?: string;
    };
    readonly asset?: string;
  };
  readonly settlement?: {
    readonly bridge_asset?: string;
  };
}

export interface LaneCheckOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly keypair?: Keypair;
  readonly bridgeAsset?: string;
  readonly asset?: string;
  readonly domain?: string;
  readonly homeDomain?: string;
  readonly webAuth?: string;
  readonly transferServerSep31?: string;
  readonly directPaymentServer?: string;
  readonly allowUnsafeUrl?: boolean;
}

function normalizeAssetCode(asset: string): string {
  return asset
    .replace(/^iso4217:/i, "")
    .toUpperCase()
    .trim();
}

/**
 * Perform a two-step lane check:
 * 1. SEP-10 authentication (login) -> acquire JWT.
 * 2. Authorised GET /sep31/info probe with Authorization: Bearer <jwt>.
 *
 * Open only when both steps pass; result indicates which step failed.
 */
export async function checkLane(
  target: string | LaneCheckTarget,
  opts: LaneCheckOptions = {},
): Promise<LaneCheckResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  const get = (url: string, init?: RequestInit) => {
    if (!opts.allowUnsafeUrl && !isSafeUrl(url)) {
      return Promise.reject(new Error(`refusing to fetch unsafe url: ${url}`));
    }
    return doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  };

  const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

  let webAuth: string | undefined = opts.webAuth;
  let transferServerSep31: string | undefined =
    opts.transferServerSep31 ?? opts.directPaymentServer;
  let homeDomain: string | undefined = opts.homeDomain ?? opts.domain;
  let bridgeAsset: string | undefined = opts.bridgeAsset ?? opts.asset;

  if (typeof target === "string") {
    if (!homeDomain) homeDomain = target;
  } else if (target && typeof target === "object") {
    webAuth =
      webAuth ??
      target.webAuth ??
      target.endpoints?.web_auth ??
      target.dest?.endpoints?.web_auth;
    transferServerSep31 =
      transferServerSep31 ??
      target.transferServerSep31 ??
      target.directPaymentServer ??
      target.endpoints?.transfer_server_sep31 ??
      target.dest?.endpoints?.transfer_server_sep31;
    homeDomain =
      homeDomain ??
      target.homeDomain ??
      target.domain ??
      target.endpoints?.home_domain ??
      target.dest?.endpoints?.home_domain;
    bridgeAsset =
      bridgeAsset ??
      target.bridgeAsset ??
      target.asset ??
      target.settlement?.bridge_asset ??
      target.dest?.asset;
  }

  // If endpoints are missing and homeDomain is available, try discovering from stellar.toml
  if ((!webAuth || !transferServerSep31) && homeDomain) {
    try {
      const res = await get(`https://${homeDomain}/.well-known/stellar.toml`);
      if (res.ok) {
        const toml = await res.text();
        if (!webAuth) webAuth = tomlValue(toml, "WEB_AUTH_ENDPOINT");
        if (!transferServerSep31)
          transferServerSep31 = tomlValue(toml, "DIRECT_PAYMENT_SERVER");
      }
    } catch {
      // discovery failure will be surfaced as missing endpoint in step 1 / step 2
    }
  }

  // --- Step 1: SEP-10 Auth (Login) -------------------------------------------
  if (!webAuth) {
    const errorMsg = "no web_auth endpoint configured";
    return {
      open: false,
      failedStep: "sep10_auth",
      step: "sep10_auth",
      passedSteps: [],
      steps: [
        {
          step: "sep10_auth",
          passed: false,
          detail: errorMsg,
          error: errorMsg,
        },
      ],
      detail: `sep10_auth failed: ${errorMsg}`,
      error: errorMsg,
    };
  }

  let token: string;
  try {
    const kp = opts.keypair ?? Keypair.random();
    const challengeUrl = new URL(webAuth);
    challengeUrl.searchParams.set("account", kp.publicKey());
    if (homeDomain) {
      challengeUrl.searchParams.set("home_domain", homeDomain);
    }

    const challengeRes = await get(challengeUrl.toString());
    if (!challengeRes.ok) {
      throw new Error(`challenge HTTP ${challengeRes.status}`);
    }

    const ch = (await challengeRes.json()) as {
      transaction?: string;
      network_passphrase?: string;
    };
    if (!ch.transaction || !ch.network_passphrase) {
      throw new Error("challenge missing transaction or network_passphrase");
    }

    const tx = TransactionBuilder.fromXDR(
      ch.transaction,
      ch.network_passphrase,
    ) as Transaction;
    tx.sign(kp);

    const tokenRes = await get(webAuth, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transaction: tx.toXDR() }),
    });
    if (!tokenRes.ok) {
      throw new Error(`token HTTP ${tokenRes.status}`);
    }

    const out = (await tokenRes.json()) as { token?: string };
    if (!out.token) {
      throw new Error("no token returned from web_auth");
    }

    token = out.token;
  } catch (e) {
    const errorMsg = why(e);
    return {
      open: false,
      failedStep: "sep10_auth",
      step: "sep10_auth",
      passedSteps: [],
      steps: [
        {
          step: "sep10_auth",
          passed: false,
          detail: errorMsg,
          error: errorMsg,
        },
      ],
      detail: `sep10_auth failed: ${errorMsg}`,
      error: errorMsg,
    };
  }

  const step1Outcome: LaneCheckStepResult = {
    step: "sep10_auth",
    passed: true,
    detail: "challenge signed, JWT issued",
  };

  // --- Step 2: Authorised GET /sep31/info Probe ------------------------------
  if (!transferServerSep31) {
    const errorMsg = "no transfer_server_sep31 endpoint configured";
    return {
      open: false,
      failedStep: "sep31_info",
      step: "sep31_info",
      passedSteps: ["sep10_auth"],
      steps: [
        step1Outcome,
        {
          step: "sep31_info",
          passed: false,
          detail: errorMsg,
          error: errorMsg,
        },
      ],
      detail: `sep31_info failed: ${errorMsg}`,
      error: errorMsg,
      token,
    };
  }

  let receiveAssets: string[];
  try {
    const infoUrl = transferServerSep31.replace(/\/+$/, "") + "/info";
    const res = await get(infoUrl, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`info HTTP ${res.status}`);
    }

    const j = (await res.json()) as {
      receive?: Record<string, { enabled?: boolean }>;
    };
    const assets = Object.keys(j?.receive ?? {});
    if (assets.length === 0) {
      throw new Error("receive list is EMPTY — advertises SEP-31 but accepts nothing");
    }

    if (bridgeAsset) {
      const normTarget = normalizeAssetCode(bridgeAsset);
      const matched = assets.find((a) => normalizeAssetCode(a) === normTarget);
      if (!matched) {
        throw new Error(
          `bridge asset "${bridgeAsset}" not accepted (accepted: ${assets.join(", ")})`,
        );
      }
      const assetConfig = j?.receive?.[matched];
      if (assetConfig && assetConfig.enabled === false) {
        throw new Error(`bridge asset "${bridgeAsset}" is disabled (enabled: false)`);
      }
    }

    receiveAssets = assets;
  } catch (e) {
    const errorMsg = why(e);
    return {
      open: false,
      failedStep: "sep31_info",
      step: "sep31_info",
      passedSteps: ["sep10_auth"],
      steps: [
        step1Outcome,
        {
          step: "sep31_info",
          passed: false,
          detail: errorMsg,
          error: errorMsg,
        },
      ],
      detail: `sep31_info failed: ${errorMsg}`,
      error: errorMsg,
      token,
    };
  }

  const step2Outcome: LaneCheckStepResult = {
    step: "sep31_info",
    passed: true,
    detail: `receives: ${receiveAssets.join(", ")}`,
  };

  return {
    open: true,
    failedStep: undefined,
    step: "sep31_info",
    passedSteps: ["sep10_auth", "sep31_info"],
    steps: [step1Outcome, step2Outcome],
    detail: `lane open: sep10_auth and sep31_info passed (receives: ${receiveAssets.join(", ")})`,
    token,
    receiveAssets,
  };
}

/** Alias for checkLane. */
export const checkSep31Lane = checkLane;
/** Alias for checkLane. */
export const laneCheck = checkLane;
/** Alias for checkLane. */
export const probeSep31Lane = checkLane;
