import { describe, expect, it } from "vitest";
import {
  RegistryRouteResolver,
  ResolverLoadError,
  StaticRouteResolver,
  UnattestedAnchorError,
  createAdapterRegistry,
  loadResolver,
  rankRoutes,
  matchesRouteTarget,
  ROUTE_RESOLVER_API_VERSION,
  type AttestationSource,
  type LoadResolverCtx,
  type RouteDecision,
  type RouteResolver,
} from "@corridor/router";
import {
  checkResolverContract,
  describeResolverContract,
  expectResolverContract,
} from "@corridor/router/testing";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import type { AnchorAdapter } from "@corridor/adapter-kit";
import type { PaymentIntent } from "@corridor/types";

function corridor(id: string): Corridor {
  const r = parseCorridor({
    id,
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: { name: "D", asset: "iso4217:ARS", endpoints: { home_domain: "d.example" } },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER" },
    recovery: {},
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

const intent = {
  idempotencyKey: "k",
  corridorId: "test",
  sender: { id: "s" },
} as PaymentIntent;
const adapterStub = { name: "stub" } as AnchorAdapter;

describe("StaticRouteResolver", () => {
  it("throws without explicit opt-in naming RegistryRouteResolver", () => {
    expect(() => new StaticRouteResolver(() => adapterStub)).toThrowError(
      /RegistryRouteResolver/,
    );
    expect(() => new StaticRouteResolver(() => adapterStub, {})).toThrowError(
      /RegistryRouteResolver/,
    );
    expect(
      () =>
        new StaticRouteResolver(() => adapterStub, {
          trustManifestWithoutAttestation: false,
        }),
    ).toThrowError(/RegistryRouteResolver/);
  });

  it("reports trust: 'manifest'", async () => {
    const resolver = new StaticRouteResolver(() => adapterStub, {
      trustManifestWithoutAttestation: true,
    });
    const decision = await resolver.resolve(intent, corridor("c1"));
    expect(decision.trust).toBe("manifest");
  });

  it("registry resolver reports trust: 'attested'", async () => {
    // The older, SEP-31-only source shape: it is adapted, so an embedder that
    // already wired one up keeps working.
    const registry = {
      servesSep31: async () => true,
      staleness: async () => 0,
      tomlHash: async () => "0".repeat(64),
    };
    const resolver = new RegistryRouteResolver({
      registry,
      adapterFor: () => adapterStub,
    });
    const decision = await resolver.resolve(intent, corridor("c1"));
    expect(decision.trust).toBe("attested");
  });

  it("returns exactly the adapter the injected factory produced", async () => {
    const resolver = new StaticRouteResolver(() => adapterStub, {
      trustManifestWithoutAttestation: true,
    });
    const decision = await resolver.resolve(intent, corridor("c1"));
    expect(decision.receiving).toBe(adapterStub);
  });

  it("passes the actual corridor argument through to the factory", async () => {
    const seen: string[] = [];
    const resolver = new StaticRouteResolver(
      (c) => {
        seen.push(c.id);
        return adapterStub;
      },
      { trustManifestWithoutAttestation: true },
    );
    await resolver.resolve(intent, corridor("c1"));
    await resolver.resolve(intent, corridor("c2"));
    expect(seen).toEqual(["c1", "c2"]);
  });

  it("never sets split", async () => {
    const resolver = new StaticRouteResolver(() => adapterStub, {
      trustManifestWithoutAttestation: true,
    });
    const decision = await resolver.resolve(intent, corridor("c1"));
    expect(decision.split).toBeUndefined();
  });

  it("invokes the factory fresh on every call — no memoization", async () => {
    let calls = 0;
    const resolver = new StaticRouteResolver(
      () => {
        calls++;
        return adapterStub;
      },
      { trustManifestWithoutAttestation: true },
    );
    const c = corridor("c1");
    await resolver.resolve(intent, c);
    await resolver.resolve(intent, c);
    expect(calls).toBe(2);
  });
});

// --- loadResolver(): deploy-time injection of a RouteResolver module -------

const ctx: LoadResolverCtx = { adapterFor: () => adapterStub };
const FIXTURE = "./tests/fixtures/resolvers/ok-resolver.ts";

describe("loadResolver", () => {
  it("loads a fixture resolver module and routes through it", async () => {
    const resolver = await loadResolver({ module: FIXTURE }, ctx);
    const decision = await resolver.resolve(intent, corridor("c1"));
    expect(decision.receiving).toBe(adapterStub);
    expect(decision.trust).toBe("manifest");
  });

  it("passes options through to the module's factory", async () => {
    const resolver = await loadResolver(
      { module: FIXTURE, options: { trust: "attested" } },
      ctx,
    );
    const decision = await resolver.resolve(intent, corridor("c1"));
    expect(decision.trust).toBe("attested");
  });

  it("rejects a missing module with a load error naming it", async () => {
    const missing = { module: "./tests/fixtures/resolvers/does-not-exist.ts" };
    await expect(loadResolver(missing, ctx)).rejects.toThrow(ResolverLoadError);
    await expect(loadResolver(missing, ctx)).rejects.toThrow(/could not be loaded/);
  });

  it("rejects a module declaring the wrong apiVersion", async () => {
    await expect(
      loadResolver({ module: "./tests/fixtures/resolvers/wrong-api-version.ts" }, ctx),
    ).rejects.toThrow(/declares apiVersion .* expected/);
  });

  it("rejects a module with no default-exported factory", async () => {
    await expect(
      loadResolver({ module: "./tests/fixtures/resolvers/no-factory.ts" }, ctx),
    ).rejects.toThrow(/default-export a factory/);
  });

  it("rejects a module whose product has no resolve function", async () => {
    await expect(
      loadResolver({ module: "./tests/fixtures/resolvers/no-resolve.ts" }, ctx),
    ).rejects.toThrow(/did not return a RouteResolver \(no resolve function\)/);
  });

  // Never load from a URL: resolver code handles real money, so its provenance
  // is a file somebody put on the machine, not whatever an http client fetches.
  it("refuses to load a resolver from a URL", async () => {
    await expect(
      loadResolver({ module: "https://evil.example/resolver.js" }, ctx),
    ).rejects.toThrow(/URLs are not loadable/);
  });
});

// --- the worked example: examples/resolvers/allowlist-resolver.ts ----------
// The third-party shape end to end: loaded THROUGH loadResolver(), gating in
// front of the resolver it composes with rather than replacing it.

const EXAMPLE = "./examples/resolvers/allowlist-resolver.ts";
/** The fixture corridor's dest home_domain. */
const EXAMPLE_DOMAIN = "d.example";

function stubResolver(): RouteResolver & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async resolve(_intent, c) {
      calls.push(c.id);
      return { receiving: adapterStub, trust: "manifest" };
    },
  };
}

describe("examples/resolvers/allowlist-resolver.ts", () => {
  it("loads through loadResolver() in the documented shape", async () => {
    const resolver = await loadResolver(
      { module: EXAMPLE, options: { domains: [EXAMPLE_DOMAIN], wrap: stubResolver() } },
      ctx,
    );
    expect(typeof resolver.resolve).toBe("function");
  });

  it("refuses a destination domain outside the allowlist", async () => {
    const wrapped = stubResolver();
    const resolver = await loadResolver(
      { module: EXAMPLE, options: { domains: ["other.example"], wrap: wrapped } },
      ctx,
    );
    await expect(resolver.resolve(intent, corridor("c1"))).rejects.toThrow(
      /not on the operator allowlist/,
    );
    // Refused BEFORE delegation: the wrapped resolver never saw the corridor.
    expect(wrapped.calls).toHaveLength(0);
  });

  it("delegates a domain on the allowlist to the wrapped resolver", async () => {
    const wrapped = stubResolver();
    const resolver = await loadResolver(
      { module: EXAMPLE, options: { domains: [EXAMPLE_DOMAIN], wrap: wrapped } },
      ctx,
    );
    const decision = await resolver.resolve(intent, corridor("c1"));
    expect(wrapped.calls).toEqual(["c1"]);
    expect(decision.receiving).toBe(adapterStub);
  });

  // The allowlist is an extra door, not a replacement: an allowlisted domain
  // still has to clear RegistryRouteResolver's attestation gate.
  it("still applies RegistryRouteResolver by default when a domain is allowlisted", async () => {
    const registry = {
      servesSep31: async () => false,
      staleness: async () => 0,
      tomlHash: async () => "0".repeat(64),
    };
    const resolver = await loadResolver(
      { module: EXAMPLE, options: { domains: [EXAMPLE_DOMAIN], registry } },
      ctx,
    );
    await expect(resolver.resolve(intent, corridor("c1"))).rejects.toThrow(
      UnattestedAnchorError,
    );
  });

  // An empty allowlist is indistinguishable from a typo; failing the boot says
  // so, instead of routing nothing and looking like an outage.
  it("fails to load when the allowlist is empty", async () => {
    await expect(loadResolver({ module: EXAMPLE, options: {} }, ctx)).rejects.toThrow(
      /empty allowlist/,
    );
  });
});

function corridorFor(id: string, dest: Record<string, unknown>): Corridor {
  const parsed = parseCorridor({
    id,
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: { name: "D", asset: "iso4217:ARS", ...dest },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER" },
    recovery: {},
  });
  if (!parsed.ok) throw new Error(`fixture invalid: ${parsed.error.message}`);
  return parsed.value;
}

const sep31Corridor = (id: string) =>
  corridorFor(id, { endpoints: { home_domain: "d.example" } });
const sep6Corridor = (id: string) =>
  corridorFor(id, {
    protocol: "sep6",
    endpoints: { home_domain: "d.example", transfer_server: "https://d.example/sep6" },
  });
const customCorridor = (id: string, name: string) =>
  corridorFor(id, {
    protocol: `custom:${name}`,
    endpoints: { home_domain: "d.example", base_url: "https://d.example/api" },
  });

describe("createAdapterRegistry", () => {
  it("dispatches sep31 corridors (including a legacy manifest with no protocol)", () => {
    const sep31Adapter = { name: "sep31" } as AnchorAdapter;
    const registry = createAdapterRegistry();
    registry.register("sep31", () => sep31Adapter);
    expect(registry.adapterFor(sep31Corridor("c1"))).toBe(sep31Adapter);
  });

  it("dispatches sep6 corridors to the sep6 factory", () => {
    const sep6Adapter = { name: "sep6" } as AnchorAdapter;
    const registry = createAdapterRegistry();
    registry.register("sep31", () => ({ name: "sep31" }) as AnchorAdapter);
    registry.register("sep6", () => sep6Adapter);
    expect(registry.adapterFor(sep6Corridor("c2"))).toBe(sep6Adapter);
  });

  it("dispatches custom protocols to their registered factory", () => {
    const customAdapter = { name: "custom" } as AnchorAdapter;
    const registry = createAdapterRegistry();
    registry.register("custom:my-anchor", () => customAdapter);
    expect(registry.adapterFor(customCorridor("c3", "my-anchor"))).toBe(customAdapter);
  });

  it("passes the corridor to the factory", () => {
    const seen: string[] = [];
    const registry = createAdapterRegistry();
    registry.register("sep31", (c) => {
      seen.push(c.id);
      return { name: "sep31" } as AnchorAdapter;
    });
    registry.adapterFor(sep31Corridor("c4"));
    expect(seen).toEqual(["c4"]);
  });

  it("has() reports whether the corridor's protocol is registered", () => {
    const registry = createAdapterRegistry();
    registry.register("sep31", () => ({ name: "sep31" }) as AnchorAdapter);
    expect(registry.has(sep31Corridor("c5"))).toBe(true);
    expect(registry.has(sep6Corridor("c5"))).toBe(false);
  });

  it("throws a clear startup error naming the protocol and the corridor id", () => {
    const registry = createAdapterRegistry();
    registry.register("sep31", () => ({ name: "sep31" }) as AnchorAdapter);
    expect(() => registry.adapterFor(sep6Corridor("corridor-x"))).toThrowError(
      /protocol "sep6".*corridor "corridor-x"/,
    );
    expect(() => registry.adapterFor(customCorridor("corridor-y", "nope"))).toThrowError(
      /protocol "custom:nope".*corridor "corridor-y"/,
    );
  });

  it("drives a StaticRouteResolver, so an unregistered protocol never builds a sep31 adapter", async () => {
    const registry = createAdapterRegistry();
    registry.register("sep31", () => ({ name: "sep31" }) as AnchorAdapter);
    const resolver = new StaticRouteResolver((c) => registry.adapterFor(c), {
      trustManifestWithoutAttestation: true,
    });
    await expect(resolver.resolve(intent, sep6Corridor("c6"))).rejects.toThrow(/sep6/);
  });
});

// --- the factory contract version exported for loaders ---------------------

describe("ROUTE_RESOLVER_API_VERSION", () => {
  it("is exported as the integer 1, the version documented in docs/route-resolver.md", () => {
    expect(ROUTE_RESOLVER_API_VERSION).toBe(1);
  });
});

// --- describeResolverContract(): the contract, executable ------------------
// A private resolver is written outside this repo, against the interface in
// `packages/router/src/index.ts`. `@corridor/router/testing` is how it proves it
// honours the documented contract; the built-ins run the same suite, so the
// suite cannot drift away from the resolvers it claims to describe.

/** The fixture home domains the suite resolves and refuses. */
const RESOLVED_DOMAIN = "resolved.example";
const UNRESOLVABLE_DOMAIN = "unresolvable.example";

/** An adapter whose name IS its home domain, so case 2 compares domains. */
function adapterForDomain(corridor: Corridor): AnchorAdapter {
  return { name: corridor.dest.endpoints.home_domain } as AnchorAdapter;
}

/** Attests the resolved domain and nothing else. */
function fakeRegistry(): AttestationSource {
  return {
    serves: async (domain) => domain === RESOLVED_DOMAIN,
    staleness: async () => 0,
    tomlHash: async () => "0".repeat(64),
  };
}

describeResolverContract(
  "StaticRouteResolver",
  () => new StaticRouteResolver(adapterForDomain, { trustManifestWithoutAttestation: true }),
  {
    // What StaticRouteResolver documents: it trusts the manifest, for every
    // corridor, and says so. It is not a gate, so it does not refuse.
    unresolvable: { outcome: "resolves", trust: "manifest" },
  },
);

describeResolverContract(
  "RegistryRouteResolver",
  () =>
    new RegistryRouteResolver({
      registry: fakeRegistry(),
      adapterFor: adapterForDomain,
    }),
  { unresolvable: { outcome: "rejects", errorPattern: /not attested as serving SEP-31/ } },
);

// The third-party shape, held to the same suite: an out-of-package resolver
// loaded through `loadResolver`.
describeResolverContract(
  "examples/resolvers/allowlist-resolver.ts",
  () =>
    loadResolver(
      {
        module: EXAMPLE,
        options: { domains: [RESOLVED_DOMAIN, UNRESOLVABLE_DOMAIN], registry: fakeRegistry() },
      },
      { adapterFor: adapterForDomain },
    ),
  { unresolvable: { outcome: "rejects", errorPattern: /not attested as serving SEP-31/ } },
);

// A green run of the suite has to be capable of meaning something, so the
// fixture below breaks all four clauses on purpose.
function brokenResolver(): RouteResolver {
  let calls = 0;
  const stub = { name: "stub" } as AnchorAdapter;
  return {
    async resolve(_intent, corridor) {
      if (corridor.dest.endpoints.home_domain === UNRESOLVABLE_DOMAIN) {
        // (3) routes a domain it has no evidence for, instead of refusing it.
        return { receiving: stub, trust: "manifest" };
      }
      calls += 1;
      return {
        // (1) a `trust` this interface does not define.
        trust: "scored" as RouteDecision["trust"],
        // (2) changes its mind between calls: a resumed payment would settle
        //     its second half somewhere else.
        receiving: { name: `anchor-${calls}` } as AnchorAdapter,
        // (4) weights that do not sum to 1.
        split: [
          { adapter: stub, weight: 0.5 },
          { adapter: stub, weight: 0.5 },
          { adapter: stub, weight: 0.3 },
        ],
      };
    },
  };
}

it.fails("describeResolverContract fails a resolver that breaks the contract", async () => {
  const report = await checkResolverContract("BrokenResolver", () => brokenResolver());
  expectResolverContract(report);
});

it("says which clause a broken resolver fails", async () => {
  const report = await checkResolverContract("BrokenResolver", () => brokenResolver());
  expect(report.passed).toBe(false);
  expect(
    report.results.map((r) => r.passed),
    report.results.map((r) => r.detail).join("\n"),
  ).toEqual([false, false, false, false]);
  expect(report.results[0].detail).toContain("scored");
  expect(report.results[1].detail).toContain("anchor-1 then anchor-2");
  expect(report.results[2].detail).toContain(UNRESOLVABLE_DOMAIN);
  expect(report.results[3].detail).toMatch(/weights sum to/);
});

describe("smart-router (rankRoutes and matchesRouteTarget)", () => {
  function makeCorridor(overrides: {
    id: string;
    domain?: string;
    limits?: { min_amount?: string; max_amount?: string };
    proof?: {
      canary_completed_at: string;
      stellar_tx_hash: string;
      anchor_transaction_id: string;
      amount: string;
    };
    endpoints_verified_at?: string;
  }): Corridor {
    const domain = overrides.domain ?? "real-anchor.com";
    const r = parseCorridor({
      id: overrides.id,
      source: { name: "Src", asset: "USDC", endpoints: { home_domain: "src.example" } },
      dest: {
        name: "Dest",
        asset: "iso4217:NGN",
        protocol: "sep31",
        endpoints: {
          home_domain: domain,
          transfer_server_sep31: `https://${domain}/sep31`,
          web_auth: `https://${domain}/auth`,
          kyc_server: `https://${domain}/kyc`,
          quote_server: `https://${domain}/sep38`,
          ...(overrides.endpoints_verified_at
            ? { endpoints_verified_at: overrides.endpoints_verified_at }
            : {}),
        },
      },
      fx: {
        path: ["USD", "USDC", "NGN"],
        quote_source: "sep38",
        quote_ttl_seconds: 60,
        who_holds_risk: "receiving_anchor",
      },
      compliance: {
        source_jurisdiction: "US",
        dest_jurisdiction: "NG",
        travel_rule_profile: "default",
      },
      settlement: { bridge_asset: "USDC", network: "public", asset_issuer: "GISSUER" },
      recovery: {},
      ...(overrides.limits ? { limits: overrides.limits } : {}),
      ...(overrides.proof ? { proof: overrides.proof } : {}),
    });
    if (!r.ok) throw new Error(`fixture invalid: ${r.error.message}`);
    return r.value;
  }

  it("matchesRouteTarget correctly matches asset and country", () => {
    const c = makeCorridor({ id: "ng-1" });
    expect(matchesRouteTarget(c, "NGN", "NG")).toBe(true);
    expect(matchesRouteTarget(c, "iso4217:NGN", "ng")).toBe(true);
    expect(matchesRouteTarget(c, "USD", "NG")).toBe(false);
    expect(matchesRouteTarget(c, "NGN", "US")).toBe(false);
  });

  it("ranks proven route ahead of verified and unverified routes", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const proven = makeCorridor({
      id: "c-proven",
      endpoints_verified_at: today,
      proof: {
        canary_completed_at: today,
        stellar_tx_hash: "a".repeat(64),
        anchor_transaction_id: "tx-1",
        amount: "100.00",
      },
    });
    const verified = makeCorridor({ id: "c-verified", endpoints_verified_at: today });
    const unverified = makeCorridor({ id: "c-unverified" });

    const routes = await rankRoutes(
      { amount: "50", to: "NGN", country: "NG", offline: true },
      [unverified, verified, proven],
    );

    expect(routes.map((r) => r.corridorId)).toEqual([
      "c-proven",
      "c-verified",
      "c-unverified",
    ]);
    expect(routes[0]?.label).toBe("PROVEN");
    expect(routes[0]?.labels).toContain("RECOMMENDED");
    expect(routes[1]?.label).toBe("VERIFIED");
    expect(routes[2]?.label).toBe("UNVERIFIED");
  });

  it("marks route as INELIGIBLE when amount exceeds max_amount", async () => {
    const c = makeCorridor({
      id: "c-limited",
      limits: { min_amount: "10.00", max_amount: "50.00" },
    });

    const routes = await rankRoutes(
      { amount: "100", to: "NGN", country: "NG", offline: true },
      [c],
    );

    expect(routes).toHaveLength(1);
    expect(routes[0]?.label).toBe("INELIGIBLE");
    expect(routes[0]?.withinLimits).toBe(false);
    expect(routes[0]?.reasons.some((r) => r.includes("exceeds maximum limit"))).toBe(true);
  });

  it("marks route as HALTED when breaker is open", async () => {
    const c = makeCorridor({ id: "c-halted" });

    const routes = await rankRoutes(
      { amount: "50", to: "NGN", country: "NG", offline: true },
      [c],
      { isBreakerOpen: (id) => id === "c-halted" },
    );

    expect(routes).toHaveLength(1);
    expect(routes[0]?.label).toBe("HALTED");
    expect(routes[0]?.runnable).toBe(false);
    expect(routes[0]?.reasons.some((r) => r.includes("circuit breaker open"))).toBe(true);
  });

  it("in live mode queries anchor using provided fetchImpl", async () => {
    const c = makeCorridor({ id: "c-live" });
    const calls: string[] = [];
    const mockFetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response("VERSION = '2.0.0'\n", { status: 200 });
    }) as typeof fetch;

    const routes = await rankRoutes(
      { amount: "50", to: "NGN", country: "NG", offline: false },
      [c],
      { fetchImpl: mockFetch },
    );

    expect(calls).toEqual(["https://real-anchor.com/.well-known/stellar.toml"]);
    expect(routes[0]?.reasons.some((r) => r.includes("anchor stellar.toml reachable"))).toBe(
      true,
    );
  });
});
