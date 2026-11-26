import { describe, expect, it, vi } from "vitest";
import type { Sep10Signer } from "@corridor/adapter-kit";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { checkLane } from "@corridor/router";

const PASSPHRASE = "Test SDF Network ; September 2015";
const JWT = "header.eyJzdWIiOiJHQlVTSU5FU1MifQ.signature";

interface Endpoints {
  readonly webAuth?: string;
  readonly sep31?: string;
  readonly receiveAsset?: string;
}

function corridor({ webAuth, sep31, receiveAsset }: Endpoints = {}): Corridor {
  const parsed = parseCorridor({
    id: "lane-test",
    source: { name: "Sender", asset: "USDC", endpoints: { home_domain: "source.example" } },
    dest: {
      name: "Receiving Anchor",
      asset: "iso4217:ARS",
      endpoints: {
        home_domain: "receiver.example",
        ...(webAuth ? { web_auth: webAuth } : {}),
        ...(sep31 ? { transfer_server_sep31: sep31 } : {}),
      },
    },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: {
      network: "public",
      asset_issuer: "GISSUER",
      ...(receiveAsset
        ? { receive_asset: receiveAsset, receive_asset_issuer: "GRECEIVE" }
        : {}),
    },
    recovery: {},
  });
  if (!parsed.ok) throw new Error(`fixture invalid: ${parsed.error.message}`);
  return parsed.value;
}

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function challenge(): Response {
  return response({ transaction: "CHALLENGE_XDR", network_passphrase: PASSPHRASE });
}

function signer(account = "GBUSINESS"): Sep10Signer {
  return {
    account,
    signChallenge: vi.fn(async () => "SIGNED_CHALLENGE_XDR"),
  };
}

function info(receive: unknown, status = 200): Response {
  return response({ receive }, status);
}

const WEB_AUTH = "https://receiver.example/sep10/auth";
const SEP31 = "https://receiver.example/sep31";
/** A receiving anchor that publishes both endpoints the check needs. */
const FULL = { webAuth: WEB_AUTH, sep31: SEP31 };

describe("checkLane", () => {
  it("reports open only when SEP-10 and the authorised /info both pass", async () => {
    const business = signer();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(challenge())
      .mockResolvedValueOnce(response({ token: JWT }))
      .mockResolvedValueOnce(info({ USDC: { enabled: true } }));

    const result = await checkLane(corridor(FULL), { signer: business, fetchImpl });

    expect(result).toMatchObject({
      lane: "lane-test",
      receiver: "Receiving Anchor",
      homeDomain: "receiver.example",
      status: "open",
    });
    expect(result.failedStep).toBeUndefined();
    expect(result.detail).toContain("GBUSINESS");
    // The business signs its own challenge; the anchor's challenge reached it intact.
    expect(business.signChallenge).toHaveBeenCalledWith("CHALLENGE_XDR", PASSPHRASE);
    const challengeUrl = String(fetchImpl.mock.calls[0]?.[0]);
    expect(challengeUrl).toContain(`account=${encodeURIComponent("GBUSINESS")}`);
    expect(challengeUrl).toContain("home_domain=receiver.example");
  });

  it("never puts the JWT in the result", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(challenge())
      .mockResolvedValueOnce(response({ token: JWT }))
      .mockResolvedValueOnce(info({ USDC: {} }));

    const result = await checkLane(corridor(FULL), { signer: signer(), fetchImpl });

    expect(result.detail).not.toContain(JWT);
    expect(JSON.stringify(result)).not.toContain(JWT);
  });

  it("reports closed when the stub anchor refuses the signed challenge", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(challenge())
      .mockResolvedValueOnce(response({ error: "account not onboarded" }, 403));

    const result = await checkLane(corridor(FULL), { signer: signer(), fetchImpl });

    expect(result.status).toBe("closed");
    expect(result.failedStep).toBe("sep10_auth");
    expect(result.detail).toContain("HTTP 403");
    // A refused login never reaches the SEP-31 server.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports closed when the challenge request itself is refused", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response({ error: "unauthorized" }, 401));

    const result = await checkLane(corridor(FULL), { signer: signer(), fetchImpl });

    expect(result.status).toBe("closed");
    expect(result.failedStep).toBe("sep10_auth");
    expect(result.detail).toContain("HTTP 401");
  });

  it("reports unknown on an anchor server error", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(challenge())
      .mockResolvedValueOnce(response({ error: "boom" }, 500));

    const result = await checkLane(corridor(FULL), { signer: signer(), fetchImpl });

    expect(result.status).toBe("unknown");
    expect(result.failedStep).toBe("sep10_auth");
    expect(result.detail).toContain("could not be checked");
  });

  it("reports unknown — not closed — when the anchor answers 400", async () => {
    // 400 can mean our own malformed challenge; it is not an onboarding refusal.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(challenge())
      .mockResolvedValueOnce(response({ error: "invalid transaction" }, 400));

    const result = await checkLane(corridor(FULL), { signer: signer(), fetchImpl });

    expect(result.status).toBe("unknown");
  });

  it("reports unknown when the anchor cannot be reached", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await checkLane(corridor(FULL), { signer: signer(), fetchImpl });

    expect(result.status).toBe("unknown");
  });

  it("reports unknown when the corridor declares no SEP-10 endpoint", async () => {
    const fetchImpl = vi.fn();

    const result = await checkLane(corridor({ sep31: SEP31 }), {
      signer: signer(),
      fetchImpl,
    });

    expect(result.status).toBe("unknown");
    expect(result.failedStep).toBe("sep10_auth");
    expect(result.detail).toContain("no SEP-10 web_auth endpoint");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("checkLane — authorised GET /sep31/info (step two)", () => {
  /** A stub anchor whose login succeeds; the third answer is its `/info`. */
  function loginThen(infoResponse: Response | Error) {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(challenge())
      .mockResolvedValueOnce(response({ token: JWT }));
    if (infoResponse instanceof Error) fetchImpl.mockRejectedValueOnce(infoResponse);
    else fetchImpl.mockResolvedValueOnce(infoResponse);
    return fetchImpl;
  }

  it("calls /info on the manifest's SEP-31 server with the JWT as bearer", async () => {
    const fetchImpl = loginThen(info({ USDC: {} }));

    await checkLane(corridor({ webAuth: WEB_AUTH, sep31: `${SEP31}/` }), {
      signer: signer(),
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const [url, init] = fetchImpl.mock.calls[2] as [string, RequestInit];
    expect(url).toBe(`${SEP31}/info`);
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${JWT}`);
  });

  it.each([401, 403])(
    "reports closed at sep31_info when /info refuses the JWT with HTTP %i",
    async (status) => {
      const fetchImpl = loginThen(response({ error: "forbidden" }, status));

      const result = await checkLane(corridor(FULL), { signer: signer(), fetchImpl });

      expect(result.status).toBe("closed");
      expect(result.failedStep).toBe("sep31_info");
      expect(result.detail).toContain(`HTTP ${status}`);
      expect(JSON.stringify(result)).not.toContain(JWT);
    },
  );

  it("reports closed at sep31_info when the receive list is empty", async () => {
    const fetchImpl = loginThen(info({}));

    const result = await checkLane(corridor(FULL), { signer: signer(), fetchImpl });

    expect(result.status).toBe("closed");
    expect(result.failedStep).toBe("sep31_info");
    expect(result.detail).toContain("receives: nothing");
  });

  it("reports closed at sep31_info when the settlement asset is not received", async () => {
    const fetchImpl = loginThen(info({ EURC: {} }));

    const result = await checkLane(corridor(FULL), { signer: signer(), fetchImpl });

    expect(result.status).toBe("closed");
    expect(result.failedStep).toBe("sep31_info");
    expect(result.detail).toContain("does not receive USDC (receives: EURC)");
  });

  it("reports closed at sep31_info when the settlement asset is disabled", async () => {
    const fetchImpl = loginThen(info({ USDC: { enabled: false } }));

    const result = await checkLane(corridor(FULL), { signer: signer(), fetchImpl });

    expect(result.status).toBe("closed");
    expect(result.failedStep).toBe("sep31_info");
    expect(result.detail).toContain("enabled: false");
  });

  it("checks the receive asset rather than the bridge asset when the corridor path-pays", async () => {
    const fetchImpl = loginThen(info({ USDC: {} }));

    const result = await checkLane(corridor({ ...FULL, receiveAsset: "ARST" }), {
      signer: signer(),
      fetchImpl,
    });

    expect(result.status).toBe("closed");
    expect(result.detail).toContain("does not receive ARST");
  });

  it("matches receive keys by asset code, ignoring case and a stellar: prefix", async () => {
    const fetchImpl = loginThen(info({ "stellar:usdc:GISSUER": {} }));

    const result = await checkLane(corridor(FULL), { signer: signer(), fetchImpl });

    expect(result.status).toBe("open");
  });

  it("reports unknown — not closed — at sep31_info on a server error", async () => {
    const fetchImpl = loginThen(response({ error: "boom" }, 500));

    const result = await checkLane(corridor(FULL), { signer: signer(), fetchImpl });

    expect(result.status).toBe("unknown");
    expect(result.failedStep).toBe("sep31_info");
    expect(result.detail).toContain("HTTP 500");
  });

  it("reports unknown at sep31_info when /info cannot be reached", async () => {
    const fetchImpl = loginThen(new Error("ECONNRESET"));

    const result = await checkLane(corridor(FULL), { signer: signer(), fetchImpl });

    expect(result.status).toBe("unknown");
    expect(result.failedStep).toBe("sep31_info");
    expect(result.detail).toContain("ECONNRESET");
  });

  it("reports unknown at sep31_info when /info has no receive object", async () => {
    const fetchImpl = loginThen(response({ sep12: {} }));

    const result = await checkLane(corridor(FULL), { signer: signer(), fetchImpl });

    expect(result.status).toBe("unknown");
    expect(result.failedStep).toBe("sep31_info");
  });

  it("reports unknown at sep31_info when the corridor declares no SEP-31 endpoint", async () => {
    const fetchImpl = loginThen(info({ USDC: {} }));

    const result = await checkLane(corridor({ webAuth: WEB_AUTH }), {
      signer: signer(),
      fetchImpl,
    });

    expect(result.status).toBe("unknown");
    expect(result.failedStep).toBe("sep31_info");
    expect(result.detail).toContain("no SEP-31 transfer_server_sep31 endpoint");
    // The JWT is never sent anywhere when there is no SEP-31 server to send it to.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
