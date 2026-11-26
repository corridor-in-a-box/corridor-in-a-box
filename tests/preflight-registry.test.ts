// Registry preflight (#584). No network: a stand-in RPC answers the two calls the
// preflight makes. The function lists come from contract specs built in memory, in
// the same shape `stellar contract build` embeds in a wasm.

import { describe, expect, it } from "vitest";
import { contract, rpc, xdr, type Transaction } from "@stellar/stellar-sdk";
import {
  ATTESTER_FUNCTIONS,
  PROBE_NAMES,
  REGISTRY_FUNCTIONS,
  SEP_NUMBERS,
  preflightRegistry,
  type PreflightServer,
} from "@corridor/registry";

const REGISTRY = "CDFOVONWR3GGMGH2OC7YATRZE64RKSRAS7UMF7R2TSC6LNNO5G32RSX4";
const ATTESTER = "CAHSKTAVHIES6MX2DUGNBA4VDB77WYNKEIZPOT7QX2RMJUL5RUIVKX2L";

/** A minimal wasm module carrying a `contractspecv0` custom section with these functions. */
function wasmWith(functions: readonly string[]): Uint8Array {
  const spec = Buffer.concat(
    functions.map((name) =>
      xdr.ScSpecEntry.scSpecEntryFunctionV0(
        new xdr.ScSpecFunctionV0({ doc: "", name, inputs: [], outputs: [] }),
      ).toXDR(),
    ),
  );
  const sectionName = Buffer.from("contractspecv0");
  const leb = (n: number) => {
    const out: number[] = [];
    do {
      let byte = n & 0x7f;
      n >>>= 7;
      if (n) byte |= 0x80;
      out.push(byte);
    } while (n);
    return Buffer.from(out);
  };
  const payload = Buffer.concat([leb(sectionName.length), sectionName, spec]);
  return Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    Buffer.from([0x00]),
    leb(payload.length),
    payload,
  ]);
}

/**
 * The u32 arguments of the transaction's contract call, by position. stellar-sdk 17
 * decodes an operation into plain objects (`{ invokeContract: { args: [{ u32: 5 }] } }`)
 * while older versions give XDR accessors; read either.
 */
function u32Args(tx: Transaction): number[] {
  const call = (x: unknown, key: string): unknown => {
    const v = (x as Record<string, unknown>)[key];
    return typeof v === "function" ? (v as () => unknown).call(x) : v;
  };
  const op = tx.operations[0] as unknown;
  const args = call(call(call(op, "func"), "invokeContract"), "args") as unknown[];
  return args.map((a) => {
    const v = call(a, "u32");
    return typeof v === "number" ? v : Number.NaN;
  });
}

interface StubOptions {
  registryFns?: readonly string[];
  attesterFns?: readonly string[];
  /** SEP numbers and probe names the "deployed" registry does not know. */
  unknownSeps?: readonly number[];
  unknownProbes?: readonly string[];
  /** Throw this many times before answering, like a dropped connection. */
  flaky?: number;
  simulationError?: string;
}

function stub(o: StubOptions = {}) {
  const calls = { simulate: 0, wasm: 0 };
  let flaky = o.flaky ?? 0;
  const knownSepMask = SEP_NUMBERS.reduce(
    (m, sep, i) => (o.unknownSeps?.includes(sep) ? m : m | (1 << i)),
    0,
  );
  const knownProbeMask = PROBE_NAMES.reduce(
    (m, probe, i) => (o.unknownProbes?.includes(probe) ? m : m | (1 << i)),
    0,
  );
  const server: PreflightServer = {
    async getContractWasmByContractId(id: string) {
      calls.wasm++;
      if (flaky > 0) {
        flaky--;
        throw new Error("fetch failed");
      }
      return wasmWith(
        id === REGISTRY
          ? (o.registryFns ?? REGISTRY_FUNCTIONS)
          : (o.attesterFns ?? ATTESTER_FUNCTIONS),
      );
    },
    async simulateTransaction(tx) {
      calls.simulate++;
      if (o.simulationError) {
        return { error: o.simulationError } as unknown as rpc.Api.SimulateTransactionResponse;
      }
      const [, seps, , probes] = u32Args(tx as Transaction);
      const unknown = (seps & ~knownSepMask) !== 0 || (probes & ~knownProbeMask) !== 0;
      if (unknown) {
        return {
          error: "HostError: Error(Contract, #4)",
        } as unknown as rpc.Api.SimulateTransactionResponse;
      }
      return {
        id: "1",
        latestLedger: 1,
        events: [],
        _parsed: true,
        transactionData: {},
        minResourceFee: "0",
        result: { auth: [], retval: xdr.ScVal.scvVoid() },
      } as unknown as rpc.Api.SimulateTransactionResponse;
    },
  };
  return { server, calls };
}

const run = (server: PreflightServer) =>
  preflightRegistry({
    network: "testnet",
    registryId: REGISTRY,
    attesterId: ATTESTER,
    rpcUrl: "https://rpc.invalid",
    networkPassphrase: "Test SDF Network ; September 2015",
    server,
    retryDelayMs: 0,
  });

describe("preflightRegistry (#584)", () => {
  it("reads function names from a contract spec the way the deployed wasm carries them", () => {
    const names = contract.Spec.fromWasm(wasmWith(["put_anchor", "get_meta"]))
      .funcs()
      .map((f) => String((f as unknown as { name: unknown }).name));
    expect(names).toEqual(["put_anchor", "get_meta"]);
  });

  it("passes when the contracts are current, with one bit simulation", async () => {
    const { server, calls } = stub();
    const r = await run(server);
    expect(r).toMatchObject({
      ok: true,
      blocking: false,
      missingFunctions: [],
      missingProbes: [],
    });
    expect(r.error).toBeUndefined();
    expect(r.registryWasmHash).toMatch(/^[0-9a-f]{64}$/);
    expect(calls).toEqual({ simulate: 1, wasm: 2 });
  });

  it("names the bits an older registry rejects and blocks the writes", async () => {
    const { server } = stub({ unknownSeps: [24], unknownProbes: ["sep6_info", "sep6_auth"] });
    const r = await run(server);
    expect(r.ok).toBe(false);
    expect(r.blocking).toBe(true);
    expect(r.missingSeps).toEqual([24]);
    expect(r.missingProbes).toEqual(["sep6_info", "sep6_auth"]);
    expect(r.error).toContain("the registry rejects SEP bits SEP-24");
    expect(r.error).toContain("probe bits sep6_info, sep6_auth");
    expect(r.error).toContain("pnpm upgrade:registry");
    expect(r.error!.split("\n")).toHaveLength(1);
  });

  it("reports the receive functions #773 added as behind but not blocking", async () => {
    // What the testnet contracts deployed on 2026-11-17 export.
    const { server } = stub({
      registryFns: REGISTRY_FUNCTIONS.filter(
        (f) => !["put_receive", "get_receive", "receive_limits"].includes(f),
      ),
      attesterFns: ATTESTER_FUNCTIONS.filter((f) => f !== "attest_receive"),
    });
    const r = await run(server);
    expect(r.ok).toBe(false);
    expect(r.blocking).toBe(false);
    expect(r.missingFunctions).toEqual([
      "registry.put_receive",
      "registry.get_receive",
      "registry.receive_limits",
      "attester.attest_receive",
    ]);
    expect(r.error).toContain("Attestations still run without the receive limits");
  });

  it("blocks when a core write function is missing", async () => {
    const { server } = stub({ attesterFns: ["attest", "registry", "admin", "upgrade"] });
    const r = await run(server);
    expect(r.blocking).toBe(true);
    expect(r.missingFunctions).toEqual(["attester.attest_meta", "attester.attest_receive"]);
  });

  it("fails closed on a simulation error it cannot interpret", async () => {
    const { server } = stub({ simulationError: "HostError: Error(Auth, InvalidAction)" });
    const r = await run(server);
    expect(r.ok).toBe(false);
    expect(r.blocking).toBe(true);
    expect(r.error).toContain("could not complete");
  });

  it("retries a dropped connection, then fails closed when it keeps dropping", async () => {
    const once = stub({ flaky: 1 });
    expect((await run(once.server)).ok).toBe(true);
    const always = stub({ flaky: 99 });
    const r = await run(always.server);
    expect(r).toMatchObject({ ok: false, blocking: true });
    expect(r.error).toContain("fetch failed");
  });

  it("refuses a network with no registry in deployments.json", async () => {
    const r = await preflightRegistry({ network: "futurenet" });
    expect(r).toMatchObject({ ok: false, blocking: true });
    expect(r.error).toContain('no registry deployed on "futurenet"');
  });
});
