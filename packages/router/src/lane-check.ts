// Lane check v1 — ask a receiving anchor whether it will let THIS business in.
//
// A receiving anchor only accepts senders it has onboarded, and many enforce
// that at SEP-10 login: the challenge is signed with our own key and the anchor
// decides whether to issue a JWT. That makes a real handshake the cheapest
// honest answer to "is this lane open to us?" — and the answer a fallback needs
// before it is worth trying (RFC 0004, docs/rfcs/0004-smart-router.md).
//
// Some receivers issue the JWT and then refuse at the SEP-31 layer, so v1 runs
// two steps (#632): the SEP-10 login, then an authorised `GET /sep31/info` with
// that JWT. The lane is open only when both pass, and a result that is not open
// names the step that stopped it (`failedStep`).
//
// Three answers, and the difference is the point:
//
//   open     the anchor issued a JWT and accepted it on `GET /info`, and its
//            receive list includes the corridor's settlement asset
//   closed   the anchor explicitly refused us: HTTP 401 / 403 at either step,
//            or an authorised `/info` that does not receive our asset (absent
//            or `enabled: false`)
//   unknown  anything else: no web_auth or SEP-31 endpoint, 5xx, timeout,
//            malformed response. A probe that could not ask is not evidence
//            that the lane is closed, so it never reports one.
//
// The JWT is used only as the bearer for that one `/info` call, sent to the
// SEP-31 server the manifest names, and is then discarded. It is a credential
// for the anchor, it has no place in a routing decision, and it is never logged
// or returned.

import { Sep10Client, type Sep10Signer } from "@corridor/adapter-kit";
import type { Corridor } from "@corridor/manifest";

/** What a SEP-10 lane check can conclude. */
export type LaneStatus =
  /** The anchor completed the handshake and issued a JWT for our account. */
  | "open"
  /** The anchor explicitly refused our credential (HTTP 401 or 403). */
  | "closed"
  /** The question could not be answered — reachability, timeout, server error. */
  | "unknown";

/** The two steps of a v1 lane check, in the order they run. */
export type LaneCheckStep =
  /** SEP-10 challenge/response with the business's own key. */
  | "sep10_auth"
  /** `GET /sep31/info` authorised with the JWT from `sep10_auth`. */
  | "sep31_info";

export interface LaneCheckOptions {
  /** The business's own SEP-10 signer; the account the anchor sees logging in. */
  readonly signer: Sep10Signer;
  /** Injectable transport, for tests and for an operator's own HTTP client. */
  readonly fetchImpl?: typeof fetch;
  /** Bound on each request to the anchor. Default 15s, as with the probe. */
  readonly timeoutMs?: number;
}

export interface LaneCheckResult {
  /** The corridor this check was run for. */
  readonly lane: string;
  /** The receiving anchor's manifest name. */
  readonly receiver: string;
  /** The receiving anchor's home domain, as the manifest declares it. */
  readonly homeDomain: string;
  readonly status: LaneStatus;
  /**
   * The step that stopped the check, set whenever `status` is not `open`:
   * `sep10_auth` when the login did not yield a JWT, `sep31_info` when the
   * authorised `/info` call did not confirm the lane. Absent when open.
   */
  readonly failedStep?: LaneCheckStep;
  /**
   * Why, in one PII-free line. Names the account and the HTTP status at most;
   * never the JWT and never a response body.
   */
  readonly detail: string;
}

// SEP-10 defines 401 for a missing credential and 403 for "this application may
// not authenticate". Both are the anchor refusing us, which is the closed
// signal. Every other status is an error we cannot attribute to an onboarding
// decision: 400 can mean our own malformed challenge, 404 a wrong endpoint, 5xx
// an anchor outage. Those stay unknown.
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([401, 403]);

function endpointOf(corridor: Corridor, key: string): string | undefined {
  const endpoints = corridor.dest.endpoints as Readonly<Record<string, unknown>>;
  const value = endpoints[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Asset code only: `USDC`, `stellar:USDC:G…` and `usdc` all become `USDC`. */
function assetCode(asset: string): string {
  const trimmed = asset.trim().replace(/^stellar:/i, "");
  return (trimmed.split(":")[0] ?? trimmed).toUpperCase();
}

type InfoOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "refused"; readonly why: string }
  | { readonly kind: "unknown"; readonly why: string };

/**
 * Ask the receiving anchor's SEP-31 server, with the JWT, whether it receives
 * `asset`. Reports the HTTP status or the asset codes at most — never a body.
 */
async function probeInfo(
  sep31: string,
  token: string,
  asset: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<InfoOutcome> {
  let base = sep31;
  while (base.endsWith("/")) base = base.slice(0, -1);
  let res: Response;
  try {
    res = await fetchImpl(`${base}/info`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : String(cause);
    return { kind: "unknown", why: `GET /info failed (${why})` };
  }

  if (REFUSAL_STATUSES.has(res.status)) {
    return { kind: "refused", why: `GET /info answered HTTP ${res.status}` };
  }
  if (!res.ok) return { kind: "unknown", why: `GET /info answered HTTP ${res.status}` };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: "unknown", why: "GET /info returned a body that is not JSON" };
  }
  const receive = (body as { receive?: unknown } | null)?.receive;
  if (typeof receive !== "object" || receive === null || Array.isArray(receive)) {
    return { kind: "unknown", why: "GET /info has no `receive` object" };
  }

  const entries = receive as Readonly<Record<string, unknown>>;
  const codes = Object.keys(entries);
  const wanted = assetCode(asset);
  const match = codes.find((code) => assetCode(code) === wanted);
  if (match === undefined) {
    const listed = codes.length > 0 ? codes.join(", ") : "nothing";
    return {
      kind: "refused",
      why: `GET /info does not receive ${wanted} (receives: ${listed})`,
    };
  }
  const config = entries[match] as { enabled?: unknown } | null;
  if (config?.enabled === false) {
    return { kind: "refused", why: `GET /info lists ${wanted} with enabled: false` };
  }
  return { kind: "accepted" };
}

/**
 * Run a SEP-10 challenge/response against the corridor's receiving anchor with
 * the business's own signer, then an authorised `GET /sep31/info` with the JWT,
 * and report whether the lane accepts us. Open only when both steps pass; any
 * other result names the step that failed in `failedStep`.
 *
 * The asset checked against the `/info` receive list is the one the anchor
 * receives on-chain: `settlement.receive_asset`, else `settlement.bridge_asset`.
 *
 * Never throws and never returns the JWT: an unreachable anchor, a bad
 * response or a signing failure all come back as `unknown` with a detail line.
 * SEP-10 authenticates an account and `/info` only reads, so this moves no
 * money and can be run before a route is chosen.
 */
export async function checkLane(
  corridor: Corridor,
  opts: LaneCheckOptions,
): Promise<LaneCheckResult> {
  const homeDomain = corridor.dest.endpoints.home_domain;
  const base = {
    lane: corridor.id,
    receiver: corridor.dest.name,
    homeDomain,
  };

  const webAuth = endpointOf(corridor, "web_auth");
  if (!webAuth) {
    return {
      ...base,
      status: "unknown",
      failedStep: "sep10_auth",
      detail: `${corridor.dest.name} publishes no SEP-10 web_auth endpoint in this corridor — cannot tell whether it would accept us`,
    };
  }

  // The shared client reports every failure as ANCHOR_UNAVAILABLE and does not
  // expose the HTTP status, so the transport is observed as it passes through:
  // the statuses are what separate an explicit refusal from an outage.
  const statuses: number[] = [];
  const baseFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const observedFetch: typeof fetch = async (input, init) => {
    const res = await baseFetch(input, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
    });
    statuses.push(res.status);
    return res;
  };

  const client = new Sep10Client(webAuth, homeDomain, opts.signer, observedFetch);
  const token = await client.token();

  if (token.ok && token.value) {
    return checkInfo(corridor, base, token.value, opts.signer.account, baseFetch, timeoutMs);
  }

  const refused = statuses.find((status) => REFUSAL_STATUSES.has(status));
  if (refused !== undefined) {
    return {
      ...base,
      status: "closed",
      failedStep: "sep10_auth",
      detail: `${corridor.dest.name} refused SEP-10 for ${opts.signer.account} (HTTP ${refused})`,
    };
  }

  const why = token.ok ? "the client returned no token" : token.error.message;
  return {
    ...base,
    status: "unknown",
    failedStep: "sep10_auth",
    detail: `${corridor.dest.name} could not be checked: ${why}`,
  };
}

/** Step two: the authorised `GET /sep31/info`. The token goes no further. */
async function checkInfo(
  corridor: Corridor,
  base: Pick<LaneCheckResult, "lane" | "receiver" | "homeDomain">,
  token: string,
  account: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<LaneCheckResult> {
  const name = corridor.dest.name;
  const sep31 = endpointOf(corridor, "transfer_server_sep31");
  if (!sep31) {
    return {
      ...base,
      status: "unknown",
      failedStep: "sep31_info",
      detail: `SEP-10 passed, but ${name} publishes no SEP-31 transfer_server_sep31 endpoint in this corridor — cannot run the authorised /info check`,
    };
  }

  const asset = corridor.settlement.receive_asset ?? corridor.settlement.bridge_asset;
  const info = await probeInfo(sep31, token, asset, fetchImpl, timeoutMs);
  switch (info.kind) {
    case "accepted":
      return {
        ...base,
        status: "open",
        detail: `SEP-10 and authorised GET /info passed — ${name} accepted ${account} and receives ${assetCode(asset)}`,
      };
    case "refused":
      return {
        ...base,
        status: "closed",
        failedStep: "sep31_info",
        detail: `SEP-10 passed, but ${name} refused ${account} at SEP-31: ${info.why}`,
      };
    case "unknown":
      return {
        ...base,
        status: "unknown",
        failedStep: "sep31_info",
        detail: `SEP-10 passed, but ${name} could not be checked at SEP-31: ${info.why}`,
      };
  }
}
