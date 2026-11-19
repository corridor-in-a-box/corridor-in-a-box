// The send app's server-side proxy to @corridor/service.
//
// The browser never holds the service API key. It calls the web app's own
// routes under /api/send, and those routes call the service with the key read
// from the server's environment. This module is the whole of that exchange.
//
// What the browser controls is only the payment body and the run key in the
// URL. It cannot choose the service URL, the path or any header, and nothing
// from the service's error bodies beyond a short allow-list is passed back.
//
// Pure and self-contained on purpose (no imports from the rest of web/, no
// Next.js types), so the behaviour is unit-tested from the repo's root suite.
// Only server route handlers import it. A client component must not: see
// tests/web-send-proxy.test.ts.

/** Where the proxy sends calls. Both come from the server's environment. */
export interface SendProxyConfig {
  serviceUrl?: string;
  apiKey?: string;
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** What a route handler turns into an HTTP response. */
export interface ProxyResult {
  status: number;
  body: unknown;
}

/**
 * The environment variables the proxy reads. They are deliberately not the ones
 * the showcase's /api/payments route uses, so enabling the send app does not
 * also lend its credentials to that route, and the key can be a separate,
 * testnet-only one. None carries the NEXT_PUBLIC_ prefix, which is what would
 * put a value in the client bundle.
 */
export const SEND_PROXY_ENV = {
  url: "SEND_APP_SERVICE_URL",
  key: "SEND_APP_SERVICE_API_KEY",
} as const;

export function sendProxyConfigFromEnv(
  env: Record<string, string | undefined>,
): SendProxyConfig {
  return { serviceUrl: env[SEND_PROXY_ENV.url], apiKey: env[SEND_PROXY_ENV.key] };
}

/** A payment intent is well under 1 KiB; anything larger is not a real request. */
export const MAX_BODY_BYTES = 16 * 1024;

/**
 * POST /payments answers only once the run has finished, which includes waiting
 * on the receiving anchor, so the wait is long. It still ends.
 */
export const SERVICE_TIMEOUT_MS = 5 * 60 * 1000;

/** The same rule the service applies to an idempotency key. */
const RUN_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Fields of a service error body that may reach the browser. */
const ERROR_FIELDS = ["error", "field", "reason", "corridorId"] as const;

const unavailable: ProxyResult = { status: 503, body: { error: "send_unavailable" } };

function relay(status: number, text: string): ProxyResult {
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    return { status: 502, body: { error: "bad_gateway" } };
  }
  if (status >= 200 && status < 300) return { status, body: parsed };
  // An error body is cut down to its code and the offending field. The service
  // puts upstream detail in `message`, and the sender has no use for it.
  const source =
    parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const body: Record<string, unknown> = {};
  for (const field of ERROR_FIELDS) {
    if (source[field] !== undefined) body[field] = source[field];
  }
  return { status, body: Object.keys(body).length > 0 ? body : { error: "service_error" } };
}

async function callService(
  config: SendProxyConfig,
  path: string,
  init: { method: "GET" | "POST"; body?: string },
): Promise<ProxyResult> {
  if (!config.serviceUrl) return unavailable;
  const doFetch = config.fetch ?? fetch;
  try {
    const res = await doFetch(`${config.serviceUrl.replace(/\/+$/, "")}${path}`, {
      method: init.method,
      // Built here, never copied from the incoming request.
      headers: {
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
    });
    return relay(res.status, await res.text());
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { status: 504, body: { error: "service_timeout" } };
    }
    return { status: 502, body: { error: "service_unreachable" } };
  }
}

/** POST /api/send/payments: forward a payment body to the service. */
export async function proxyCreatePayment(
  config: SendProxyConfig,
  rawBody: string,
): Promise<ProxyResult> {
  if (!config.serviceUrl) return unavailable;
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) {
    return { status: 413, body: { error: "payload too large" } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "invalid JSON" } };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: 400, body: { error: "invalid payment body" } };
  }
  // The service validates the fields strictly; this forwards the body as is.
  return callService(config, "/payments", { method: "POST", body: JSON.stringify(parsed) });
}

/** GET /api/send/payments/:key: read one run back from the service. */
export async function proxyGetPayment(
  config: SendProxyConfig,
  key: string,
): Promise<ProxyResult> {
  if (!config.serviceUrl) return unavailable;
  if (!RUN_KEY_PATTERN.test(key)) {
    return { status: 400, body: { error: "invalid payment key" } };
  }
  return callService(config, `/payments/${encodeURIComponent(key)}`, { method: "GET" });
}
