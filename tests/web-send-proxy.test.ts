import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_BODY_BYTES,
  SEND_PROXY_ENV,
  proxyCreatePayment,
  proxyGetPayment,
  sendProxyConfigFromEnv,
  type SendProxyConfig,
} from "../web/lib/send-proxy";

const KEY = "svc-key-1234567890";

interface Call {
  url: string;
  init: RequestInit;
}

function stub(status: number, body: string): { config: SendProxyConfig; calls: Call[] } {
  const calls: Call[] = [];
  const config: SendProxyConfig = {
    serviceUrl: "http://service.internal:8080/",
    apiKey: KEY,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(body, { status });
    }) as unknown as typeof fetch,
  };
  return { config, calls };
}

const payment = JSON.stringify({
  idempotencyKey: "run-0001",
  corridorId: "reference-testnet",
});

describe("configuration", () => {
  it("reads the dedicated send app variables", () => {
    expect(
      sendProxyConfigFromEnv({
        SEND_APP_SERVICE_URL: "http://svc",
        SEND_APP_SERVICE_API_KEY: "k",
        CORRIDOR_SERVICE_API_KEY: "other",
      }),
    ).toEqual({ serviceUrl: "http://svc", apiKey: "k" });
  });

  it("answers 503 on both routes while no service is configured", async () => {
    expect(await proxyCreatePayment({}, payment)).toEqual({
      status: 503,
      body: { error: "send_unavailable" },
    });
    expect((await proxyGetPayment({}, "run-0001")).status).toBe(503);
  });
});

describe("POST /payments", () => {
  it("forwards the body to the service with the key as a bearer token", async () => {
    const { config, calls } = stub(200, JSON.stringify({ state: "completed" }));
    const out = await proxyCreatePayment(config, payment);

    expect(out).toEqual({ status: 200, body: { state: "completed" } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://service.internal:8080/payments");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toEqual({
      "content-type": "application/json",
      authorization: `Bearer ${KEY}`,
    });
    expect(JSON.parse(calls[0].init.body as string)).toEqual(JSON.parse(payment));
  });

  it("sends no authorization header when no key is configured", async () => {
    const { config, calls } = stub(200, "{}");
    await proxyCreatePayment({ ...config, apiKey: undefined }, payment);
    expect(calls[0].init.headers).toEqual({ "content-type": "application/json" });
  });

  it("refuses an oversized body without calling the service", async () => {
    const { config, calls } = stub(200, "{}");
    const huge = JSON.stringify({ pad: "x".repeat(MAX_BODY_BYTES) });
    const out = await proxyCreatePayment(config, huge);
    expect(out.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("refuses a body that is not a JSON object", async () => {
    const { config, calls } = stub(200, "{}");
    expect((await proxyCreatePayment(config, "{nope")).status).toBe(400);
    expect((await proxyCreatePayment(config, "[1]")).status).toBe(400);
    expect((await proxyCreatePayment(config, "null")).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("relays a service error as its code and field only", async () => {
    const upstream = JSON.stringify({
      error: "invalid payment body",
      field: "sourceAmount",
      reason: "expected an object",
      message: `GET https://anchor.internal/sep31 failed with ${KEY}`,
    });
    const { config } = stub(400, upstream);
    const out = await proxyCreatePayment(config, payment);

    expect(out).toEqual({
      status: 400,
      body: {
        error: "invalid payment body",
        field: "sourceAmount",
        reason: "expected an object",
      },
    });
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it("names an error body with no code generically", async () => {
    const { config } = stub(500, JSON.stringify({ message: "boom" }));
    expect(await proxyCreatePayment(config, payment)).toEqual({
      status: 500,
      body: { error: "service_error" },
    });
  });

  it("answers 502 when the service replies with something that is not JSON", async () => {
    const { config } = stub(200, "<html>gateway</html>");
    expect(await proxyCreatePayment(config, payment)).toEqual({
      status: 502,
      body: { error: "bad_gateway" },
    });
  });

  it("answers 502 when the service cannot be reached, without echoing the cause", async () => {
    const config: SendProxyConfig = {
      serviceUrl: "http://service.internal",
      apiKey: KEY,
      fetch: (async () => {
        throw new Error(`connect ECONNREFUSED with ${KEY}`);
      }) as unknown as typeof fetch,
    };
    const out = await proxyCreatePayment(config, payment);
    expect(out).toEqual({ status: 502, body: { error: "service_unreachable" } });
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it("answers 504 when the service takes too long", async () => {
    const config: SendProxyConfig = {
      serviceUrl: "http://service.internal",
      fetch: (async () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      }) as unknown as typeof fetch,
    };
    expect(await proxyCreatePayment(config, payment)).toEqual({
      status: 504,
      body: { error: "service_timeout" },
    });
  });
});

describe("GET /payments/:key", () => {
  it("reads the run from the service with the key attached", async () => {
    const run = { idempotencyKey: "run-0001", state: "settled" };
    const { config, calls } = stub(200, JSON.stringify(run));
    const out = await proxyGetPayment(config, "run-0001");

    expect(out).toEqual({ status: 200, body: run });
    expect(calls[0].url).toBe("http://service.internal:8080/payments/run-0001");
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.headers).toEqual({ authorization: `Bearer ${KEY}` });
  });

  it("relays a missing run as 404", async () => {
    const { config } = stub(404, JSON.stringify({ error: "not found" }));
    expect(await proxyGetPayment(config, "run-0001")).toEqual({
      status: 404,
      body: { error: "not found" },
    });
  });

  it("refuses a key the service would not accept, so the path cannot be steered", async () => {
    const { config, calls } = stub(200, "{}");
    for (const key of ["../admin", "a/b", "a b", "", "x".repeat(129), "k?x=1", "%2e%2e"]) {
      expect((await proxyGetPayment(config, key)).status, key).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });
});

// The acceptance criterion: the key is not in any client bundle. A bundle holds
// whatever a client component imports, so no client component may reach the
// proxy module or name the variables, and nothing may expose them to the
// browser through the NEXT_PUBLIC_ prefix.
describe("the service key stays on the server", () => {
  const webRoot = resolve(process.cwd(), "web");

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      if (name === "node_modules" || name === ".next") return [];
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
    });
  }

  const files = sources(webRoot).map((path) => ({ path, text: readFileSync(path, "utf8") }));

  it("is read only by the proxy module and its routes", () => {
    const readers = files
      .filter((f) => f.text.includes(SEND_PROXY_ENV.key) && !f.path.endsWith("send-proxy.ts"))
      .map((f) => f.path);
    expect(readers).toEqual([]);
  });

  it("is never reachable from a client component", () => {
    const client = files.filter((f) => /^\s*["']use client["']/.test(f.text));
    expect(client.length).toBeGreaterThan(0);
    for (const f of client) {
      expect(f.text, f.path).not.toContain("send-proxy");
      expect(f.text, f.path).not.toContain(SEND_PROXY_ENV.key);
    }
  });

  it("is not exposed through the NEXT_PUBLIC_ prefix or next.config env", () => {
    for (const f of files) {
      expect(f.text, f.path).not.toContain(`NEXT_PUBLIC_${SEND_PROXY_ENV.key}`);
    }
    const config = files.find((f) => f.path.endsWith("next.config.ts"));
    expect(config?.text).not.toContain(SEND_PROXY_ENV.key);
  });

  it("has route handlers that call the proxy module", () => {
    const routes = files.filter((f) => /app[\\/]api[\\/]send[\\/].*route\.ts$/.test(f.path));
    expect(routes).toHaveLength(2);
    for (const r of routes) expect(r.text, r.path).toContain("@/lib/send-proxy");
  });
});
