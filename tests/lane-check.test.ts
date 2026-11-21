// tests/lane-check.test.ts — Lane check v1: authorised GET /sep31/info probe (Issue #632)
//
// Acceptance criteria:
// - Open only when both steps pass (sep10_auth and sep31_info).
// - The result says which step failed.

import { describe, expect, it } from "vitest";
import {
  Keypair,
  TransactionBuilder,
  Networks,
  Operation,
  Account,
} from "@stellar/stellar-sdk";
import {
  checkLane,
  checkSep31Lane,
  laneCheck,
  probeSep31Lane,
  type LaneCheckResult,
} from "@corridor/probe";
import { checkLane as checkLaneFromRouter } from "@corridor/router";
import { parseCorridor, type Corridor } from "@corridor/manifest";

const PASSPHRASE = Networks.TESTNET;

function challengeXdr(serverKp: Keypair, clientAccount: string): string {
  const account = new Account(serverKp.publicKey(), "-1");
  return new TransactionBuilder(account, { fee: "100", networkPassphrase: PASSPHRASE })
    .addOperation(
      Operation.manageData({
        name: "a.example auth",
        value: Buffer.alloc(48, "a"),
        source: clientAccount,
      }),
    )
    .setTimeout(300)
    .build()
    .toXDR();
}

interface MockServerOptions {
  authChallengeOk?: boolean;
  authChallengeMissingFields?: boolean;
  authTokenOk?: boolean;
  authTokenStatus?: number;
  authTokenEmpty?: boolean;
  sep31InfoOk?: boolean;
  sep31InfoStatus?: number;
  sep31Receive?: Record<string, { enabled?: boolean }> | null;
  stellarToml?: string;
}

function makeMockServer(o: MockServerOptions = {}) {
  const serverKp = Keypair.random();
  const calls: string[] = [];
  const authHeaders: (string | null)[] = [];

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${u}`);
    const headers = new Headers(init?.headers);
    authHeaders.push(headers.get("authorization"));

    if (u.includes("stellar.toml")) {
      return new Response(
        o.stellarToml ??
          `
VERSION = "2.0.0"
WEB_AUTH_ENDPOINT = "https://a.example/auth"
DIRECT_PAYMENT_SERVER = "https://a.example/sep31"
`,
        { status: 200 },
      );
    }

    if (u.includes("/auth")) {
      if (method === "POST") {
        if (o.authTokenOk === false || (o.authTokenStatus && o.authTokenStatus >= 400)) {
          return json({ error: "denied" }, o.authTokenStatus ?? 403);
        }
        if (o.authTokenEmpty) {
          return json({});
        }
        return json({ token: "jwt-test-token-12345" });
      }

      if (o.authChallengeOk === false) {
        return json({ error: "server error" }, 500);
      }
      if (o.authChallengeMissingFields) {
        return json({});
      }

      const parsedUrl = new URL(u);
      const account = parsedUrl.searchParams.get("account")!;
      return json({
        transaction: challengeXdr(serverKp, account),
        network_passphrase: PASSPHRASE,
      });
    }

    if (u.includes("/sep31/info") || u.endsWith("/sep31") || u.includes("/sep31")) {
      if (o.sep31InfoOk === false || (o.sep31InfoStatus && o.sep31InfoStatus >= 400)) {
        return json({ error: "unauthorized" }, o.sep31InfoStatus ?? 401);
      }
      if (o.sep31Receive === null) {
        return json({ receive: {} });
      }
      const receive = o.sep31Receive ?? {
        USDC: { enabled: true },
        NGN: { enabled: true },
      };
      return json({ receive });
    }

    return json({ error: "not found" }, 404);
  }) as typeof fetch;

  return { fetchImpl, calls, authHeaders };
}

function validCorridorFixture(
  overrides: {
    bridgeAsset?: string;
    webAuth?: string;
    transferServer?: string;
  } = {},
): Corridor {
  const r = parseCorridor({
    id: "test-lane-1",
    source: { name: "Source", asset: "USDC", endpoints: { home_domain: "src.example" } },
    dest: {
      name: "Dest",
      asset: "iso4217:NGN",
      protocol: "sep31",
      endpoints: {
        home_domain: "a.example",
        transfer_server_sep31: overrides.transferServer ?? "https://a.example/sep31",
        web_auth: overrides.webAuth ?? "https://a.example/auth",
      },
    },
    fx: { path: ["USDC", "NGN"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "US", dest_jurisdiction: "NG" },
    settlement: {
      bridge_asset: overrides.bridgeAsset ?? "USDC",
      network: "testnet",
      asset_issuer: "GISSUER",
    },
    recovery: {},
  });
  if (!r.ok) throw new Error(`corridor fixture invalid: ${r.error.message}`);
  return r.value;
}

describe("Lane check v1: authorised GET /sep31/info probe (#632)", () => {
  describe("Happy path: open when both steps pass", () => {
    it("returns open: true when sep10_auth and sep31_info both succeed", async () => {
      const { fetchImpl, authHeaders } = makeMockServer();
      const corridor = validCorridorFixture();

      const result: LaneCheckResult = await checkLane(corridor, { fetchImpl });

      expect(result.open).toBe(true);
      expect(result.failedStep).toBeUndefined();
      expect(result.passedSteps).toEqual(["sep10_auth", "sep31_info"]);
      expect(result.token).toBe("jwt-test-token-12345");
      expect(result.receiveAssets).toEqual(["USDC", "NGN"]);
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0]).toMatchObject({ step: "sep10_auth", passed: true });
      expect(result.steps[1]).toMatchObject({ step: "sep31_info", passed: true });

      // Verifies that step 2 was called with Authorization: Bearer <jwt>
      const infoCallAuth = authHeaders.find((h) => h === "Bearer jwt-test-token-12345");
      expect(infoCallAuth).toBe("Bearer jwt-test-token-12345");
    });

    it("works when re-exported from @corridor/router", async () => {
      const { fetchImpl } = makeMockServer();
      const corridor = validCorridorFixture();

      const result = await checkLaneFromRouter(corridor, { fetchImpl });
      expect(result.open).toBe(true);
      expect(result.failedStep).toBeUndefined();
    });

    it("works with explicit LaneCheckTarget endpoints", async () => {
      const { fetchImpl } = makeMockServer();
      const result = await checkLane(
        {
          webAuth: "https://a.example/auth",
          transferServerSep31: "https://a.example/sep31",
          homeDomain: "a.example",
          bridgeAsset: "USDC",
        },
        { fetchImpl },
      );

      expect(result.open).toBe(true);
      expect(result.failedStep).toBeUndefined();
      expect(result.receiveAssets).toContain("USDC");
    });

    it("discovers endpoints from domain stellar.toml when only domain is provided", async () => {
      const { fetchImpl } = makeMockServer();
      const result = await checkLane("a.example", { fetchImpl, bridgeAsset: "USDC" });

      expect(result.open).toBe(true);
      expect(result.failedStep).toBeUndefined();
      expect(result.passedSteps).toEqual(["sep10_auth", "sep31_info"]);
    });
  });

  describe("Failure in Step 1 (sep10_auth)", () => {
    it("reports failedStep: 'sep10_auth' when challenge request returns 500", async () => {
      const { fetchImpl, calls } = makeMockServer({ authChallengeOk: false });
      const corridor = validCorridorFixture();

      const result = await checkLane(corridor, { fetchImpl });

      expect(result.open).toBe(false);
      expect(result.failedStep).toBe("sep10_auth");
      expect(result.step).toBe("sep10_auth");
      expect(result.passedSteps).toEqual([]);
      expect(result.detail).toContain("sep10_auth failed");
      expect(result.error).toContain("challenge HTTP 500");

      // Step 2 must NOT have run
      expect(calls.some((c) => c.includes("/sep31"))).toBe(false);
    });

    it("reports failedStep: 'sep10_auth' when challenge response has missing fields", async () => {
      const { fetchImpl, calls } = makeMockServer({ authChallengeMissingFields: true });
      const corridor = validCorridorFixture();

      const result = await checkLane(corridor, { fetchImpl });

      expect(result.open).toBe(false);
      expect(result.failedStep).toBe("sep10_auth");
      expect(result.error).toContain("missing transaction or network_passphrase");
      expect(calls.some((c) => c.includes("/sep31"))).toBe(false);
    });

    it("reports failedStep: 'sep10_auth' when token exchange returns 403", async () => {
      const { fetchImpl, calls } = makeMockServer({
        authTokenOk: false,
        authTokenStatus: 403,
      });
      const corridor = validCorridorFixture();

      const result = await checkLane(corridor, { fetchImpl });

      expect(result.open).toBe(false);
      expect(result.failedStep).toBe("sep10_auth");
      expect(result.error).toContain("token HTTP 403");
      expect(calls.some((c) => c.includes("/sep31"))).toBe(false);
    });

    it("reports failedStep: 'sep10_auth' when token response contains no token", async () => {
      const { fetchImpl, calls } = makeMockServer({ authTokenEmpty: true });
      const corridor = validCorridorFixture();

      const result = await checkLane(corridor, { fetchImpl });

      expect(result.open).toBe(false);
      expect(result.failedStep).toBe("sep10_auth");
      expect(result.error).toContain("no token returned");
      expect(calls.some((c) => c.includes("/sep31"))).toBe(false);
    });

    it("reports failedStep: 'sep10_auth' when web_auth endpoint is not configured", async () => {
      const { fetchImpl } = makeMockServer();
      const result = await checkLane(
        { transferServerSep31: "https://a.example/sep31" },
        { fetchImpl },
      );

      expect(result.open).toBe(false);
      expect(result.failedStep).toBe("sep10_auth");
      expect(result.error).toContain("no web_auth endpoint configured");
    });
  });

  describe("Failure in Step 2 (sep31_info)", () => {
    it("reports failedStep: 'sep31_info' when receiver rejects the JWT with 401", async () => {
      const { fetchImpl } = makeMockServer({ sep31InfoOk: false, sep31InfoStatus: 401 });
      const corridor = validCorridorFixture();

      const result = await checkLane(corridor, { fetchImpl });

      expect(result.open).toBe(false);
      expect(result.failedStep).toBe("sep31_info");
      expect(result.step).toBe("sep31_info");
      expect(result.passedSteps).toEqual(["sep10_auth"]);
      expect(result.token).toBe("jwt-test-token-12345");
      expect(result.detail).toContain("sep31_info failed");
      expect(result.error).toContain("info HTTP 401");
    });

    it("reports failedStep: 'sep31_info' when receiver returns 403", async () => {
      const { fetchImpl } = makeMockServer({ sep31InfoOk: false, sep31InfoStatus: 403 });
      const corridor = validCorridorFixture();

      const result = await checkLane(corridor, { fetchImpl });

      expect(result.open).toBe(false);
      expect(result.failedStep).toBe("sep31_info");
      expect(result.error).toContain("info HTTP 403");
      expect(result.passedSteps).toEqual(["sep10_auth"]);
    });

    it("reports failedStep: 'sep31_info' when receiver returns empty receive list", async () => {
      const { fetchImpl } = makeMockServer({ sep31Receive: null });
      const corridor = validCorridorFixture();

      const result = await checkLane(corridor, { fetchImpl });

      expect(result.open).toBe(false);
      expect(result.failedStep).toBe("sep31_info");
      expect(result.error).toContain("receive list is EMPTY");
      expect(result.passedSteps).toEqual(["sep10_auth"]);
    });

    it("reports failedStep: 'sep31_info' when bridge asset is not in receive list", async () => {
      const { fetchImpl } = makeMockServer({
        sep31Receive: {
          EURC: { enabled: true },
        },
      });
      const corridor = validCorridorFixture({ bridgeAsset: "USDC" });

      const result = await checkLane(corridor, { fetchImpl });

      expect(result.open).toBe(false);
      expect(result.failedStep).toBe("sep31_info");
      expect(result.error).toContain('bridge asset "USDC" not accepted');
      expect(result.passedSteps).toEqual(["sep10_auth"]);
    });

    it("reports failedStep: 'sep31_info' when bridge asset is disabled", async () => {
      const { fetchImpl } = makeMockServer({
        sep31Receive: {
          USDC: { enabled: false },
        },
      });
      const corridor = validCorridorFixture({ bridgeAsset: "USDC" });

      const result = await checkLane(corridor, { fetchImpl });

      expect(result.open).toBe(false);
      expect(result.failedStep).toBe("sep31_info");
      expect(result.error).toContain('bridge asset "USDC" is disabled');
      expect(result.passedSteps).toEqual(["sep10_auth"]);
    });

    it("reports failedStep: 'sep31_info' when transfer_server_sep31 is missing", async () => {
      const { fetchImpl } = makeMockServer();
      const result = await checkLane({ webAuth: "https://a.example/auth" }, { fetchImpl });

      expect(result.open).toBe(false);
      expect(result.failedStep).toBe("sep31_info");
      expect(result.error).toContain("no transfer_server_sep31 endpoint configured");
      expect(result.passedSteps).toEqual(["sep10_auth"]);
    });
  });

  describe("Function aliases", () => {
    it("checkSep31Lane, laneCheck, and probeSep31Lane behave identically to checkLane", async () => {
      const { fetchImpl } = makeMockServer();
      const corridor = validCorridorFixture();

      const r1 = await checkLane(corridor, { fetchImpl });
      const r2 = await checkSep31Lane(corridor, { fetchImpl });
      const r3 = await laneCheck(corridor, { fetchImpl });
      const r4 = await probeSep31Lane(corridor, { fetchImpl });

      expect(r1.open).toBe(true);
      expect(r2.open).toBe(true);
      expect(r3.open).toBe(true);
      expect(r4.open).toBe(true);
    });
  });
});
