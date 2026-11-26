// Preflight for the nightly attestation (#584): is the deployed registry (and the
// attester that writes to it) as new as `main`?
//
// The registry validates every write against the SEP and probe bits it was
// compiled with, so a registry older than `SEP_NUMBERS` / `PROBE_NAMES` here
// rejects exactly the anchors with the richest results (`UnknownBit`, contract
// error #4), and an older attester or registry lacks newer functions altogether
// (`Error(WasmVm, MissingValue)`). Without a preflight that shows up as one
// failure per anchor. This check answers once, before any write:
//
// 1. Functions: reads each deployed contract's wasm and its contract spec, and
//    lists any function the TypeScript clients call that it does not export.
// 2. Bits: simulates `put_anchor` with every current SEP and probe bit set. The
//    registry checks the bits before it touches storage, so `UnknownBit` means it
//    is behind; one simulation per bit then names the missing ones.
//
// Read-only: simulations only, no key, no fee, nothing submitted. It fails closed:
// an answer it cannot interpret is an error, never a pass.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Account,
  Address,
  Contract,
  contract as sdkContract,
  nativeToScVal,
  rpc,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { PROBE_NAMES, RegistryContractError, SEP_NUMBERS, contractErrorCode } from "./index";

/** One network's entry in `contracts/deployments.json`. */
export interface DeploymentEntry {
  networkPassphrase: string;
  rpcUrl: string;
  registry: string | null;
  attester: string | null;
}

export type DeploymentsConfig = Record<string, DeploymentEntry | unknown>;

/**
 * Registry functions the clients in this repo call: `AnchorRegistry` reads, and
 * the attester contract's cross-contract writes.
 */
export const REGISTRY_FUNCTIONS = [
  "put_anchor",
  "put_meta",
  "put_receive",
  "bump",
  "get_anchor",
  "get_meta",
  "get_receive",
  "receives_asset",
  "receive_limits",
  "domains",
  "staleness",
  "serves_sep31",
  "serves_sep6",
  "admin",
  "attester",
  "upgrade",
] as const;

/** Attester functions `AnchorAttester` calls, plus `upgrade` for the runbook. */
export const ATTESTER_FUNCTIONS = [
  "attest",
  "attest_meta",
  "attest_receive",
  "registry",
  "admin",
  "upgrade",
] as const;

/**
 * Functions whose absence `pnpm attest` already survives: it skips the receive
 * limits for the run with one warning and still writes the bitmaps and metadata
 * (docs/registry-metadata.md). Missing only these, the contracts are behind but
 * the night's attestations can still land, so the preflight reports it without
 * blocking them.
 */
export const NON_BLOCKING_FUNCTIONS: readonly string[] = [
  "registry.put_receive",
  "registry.get_receive",
  "registry.receive_limits",
  "attester.attest_receive",
];

/** The minimal RPC surface the preflight uses, so a test can stand in for the network. */
export type PreflightServer = Pick<
  rpc.Server,
  "simulateTransaction" | "getContractWasmByContractId"
>;

export interface PreflightOptions {
  /** A key of `contracts/deployments.json`; defaults to `testnet`. */
  network?: string;
  /** Tries per RPC call when the call itself throws (default 3). */
  attempts?: number;
  /** Base delay between those tries, in ms (default 1000). */
  retryDelayMs?: number;
  /** Overrides for what deployments.json says. */
  registryId?: string;
  attesterId?: string | null;
  rpcUrl?: string;
  networkPassphrase?: string;
  deploymentsPath?: string;
  server?: PreflightServer;
}

export interface PreflightResult {
  ok: boolean;
  network: string;
  registryId: string;
  attesterId: string | null;
  /** sha256 of the deployed wasm, when it could be read. */
  registryWasmHash?: string;
  attesterWasmHash?: string;
  /** SEP numbers the deployed registry rejects. */
  missingSeps: number[];
  /** Probe names the deployed registry rejects. */
  missingProbes: string[];
  /** `contract.function` names the clients call but the deployed wasm lacks. */
  missingFunctions: string[];
  /**
   * Whether attesting now would fail per anchor (a rejected bit, a missing core
   * function, or a check that could not complete). False when `ok`, or when only
   * `NON_BLOCKING_FUNCTIONS` are missing.
   */
  blocking: boolean;
  /** One line, set when `ok` is false. */
  error?: string;
}

/** The all-zero account. Valid to simulate against; cannot sign anything. */
const SIMULATION_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
/** `.invalid` is reserved (RFC 2606), so this can never be a real anchor's record. */
const PREFLIGHT_DOMAIN = "registry-preflight.invalid";

/** Reads `contracts/deployments.json` (or another path). */
export function loadDeployments(path?: string): DeploymentsConfig {
  const p = path ?? join(process.cwd(), "contracts", "deployments.json");
  return JSON.parse(readFileSync(p, "utf8")) as DeploymentsConfig;
}

function deploymentFor(
  config: DeploymentsConfig,
  network: string,
): DeploymentEntry | undefined {
  if (network.startsWith("$")) return undefined;
  const entry = config[network];
  if (typeof entry !== "object" || entry === null) return undefined;
  return entry as DeploymentEntry;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Retries a network call that threw (a dropped connection, a timeout). An answer
 * from the contract, even an error, is returned on the first try.
 */
async function withRetry<T>(
  call: () => Promise<T>,
  attempts: number,
  delayMs: number,
): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await call();
    } catch (e) {
      if (i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, delayMs * i));
    }
  }
}

function bitsOf(count: number): number {
  return count >= 32 ? 0xffffffff : (1 << count) - 1;
}

type BitOutcome = "accepted" | "unknown_bit";

/**
 * Simulates `put_anchor` with the given masks. The registry checks the bits right
 * after the writer's `require_auth` (which simulation records rather than
 * enforces), before any storage, so success means the bits were accepted.
 */
async function simulatePutAnchor(
  server: PreflightServer,
  registry: Contract,
  networkPassphrase: string,
  writer: string,
  seps: number,
  probesRun: number,
): Promise<BitOutcome> {
  const tx = new TransactionBuilder(new Account(SIMULATION_ACCOUNT, "0"), {
    fee: "100",
    networkPassphrase,
  })
    .addOperation(
      registry.call(
        "put_anchor",
        nativeToScVal(PREFLIGHT_DOMAIN, { type: "string" }),
        nativeToScVal(seps, { type: "u32" }),
        nativeToScVal(Buffer.alloc(32), { type: "bytes" }),
        nativeToScVal(probesRun, { type: "u32" }),
        nativeToScVal(0, { type: "u32" }),
        new Address(writer).toScVal(),
      ),
    )
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationError(sim)) return "accepted";
  const code = contractErrorCode(sim.error);
  if (code === RegistryContractError.UnknownBit) return "unknown_bit";
  // RegistryFull is raised after the bit check, so the bits were accepted.
  if (code === RegistryContractError.RegistryFull) return "accepted";
  throw new Error(`put_anchor simulation failed unexpectedly: ${sim.error}`);
}

/**
 * A spec function's name. The SDK types it as an XDR object with a `name()`
 * method, but `Spec.fromWasm` in stellar-sdk 17 yields plain objects whose `name`
 * field is an `XdrString`; read any of these.
 */
function functionName(f: unknown): string {
  const name = (f as { name?: unknown }).name;
  const value = typeof name === "function" ? (name as () => unknown).call(f) : name;
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  // An XdrString (stellar-sdk 17) prints as its text.
  if (typeof value === "object" && value !== null) return String(value);
  throw new Error("cannot read a function name from the contract spec");
}

async function exportedFunctions(
  server: PreflightServer,
  contractId: string,
): Promise<{ names: Set<string>; hash: string }> {
  const wasm = await server.getContractWasmByContractId(contractId);
  const spec = sdkContract.Spec.fromWasm(wasm);
  return {
    names: new Set(spec.funcs().map(functionName)),
    hash: sha256Hex(wasm),
  };
}

function describeError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  const cause =
    e instanceof Error ? (e.cause as { code?: unknown; message?: unknown }) : undefined;
  const detail = cause?.code ?? cause?.message;
  return detail ? `${message} (${String(detail)})` : message;
}

/**
 * Checks the deployed registry (and attester, when one is configured) against the
 * SEP and probe bits and the functions on this checkout. Never throws for a
 * network answer: anything unexpected comes back as `ok: false` with an `error`.
 */
export async function preflightRegistry(
  options: PreflightOptions = {},
): Promise<PreflightResult> {
  const network = options.network ?? "testnet";
  const base: PreflightResult = {
    ok: false,
    network,
    registryId: options.registryId ?? "unknown",
    attesterId: options.attesterId ?? null,
    missingSeps: [],
    missingProbes: [],
    missingFunctions: [],
    blocking: true,
  };

  let registryId = options.registryId;
  let attesterId = options.attesterId;
  let rpcUrl = options.rpcUrl;
  let networkPassphrase = options.networkPassphrase;
  if (!registryId || attesterId === undefined || !rpcUrl || !networkPassphrase) {
    let entry: DeploymentEntry | undefined;
    try {
      entry = deploymentFor(loadDeployments(options.deploymentsPath), network);
    } catch (e) {
      return { ...base, error: `cannot read deployments.json: ${(e as Error).message}` };
    }
    if (!entry?.registry) {
      return {
        ...base,
        error: `no registry deployed on "${network}" in contracts/deployments.json`,
      };
    }
    registryId ??= entry.registry;
    if (attesterId === undefined) attesterId = entry.attester;
    rpcUrl ??= entry.rpcUrl;
    networkPassphrase ??= entry.networkPassphrase;
  }
  const result: PreflightResult = { ...base, registryId, attesterId: attesterId ?? null };

  const rpcServer: PreflightServer = options.server ?? new rpc.Server(rpcUrl);
  const attempts = options.attempts ?? 3;
  const delay = options.retryDelayMs ?? 1000;
  const server: PreflightServer = {
    simulateTransaction: (tx) =>
      withRetry(() => rpcServer.simulateTransaction(tx), attempts, delay),
    getContractWasmByContractId: (id) =>
      withRetry(() => rpcServer.getContractWasmByContractId(id), attempts, delay),
  };
  const registry = new Contract(registryId);

  try {
    // 1. Functions.
    const reg = await exportedFunctions(server, registryId);
    result.registryWasmHash = reg.hash;
    for (const fn of REGISTRY_FUNCTIONS) {
      if (!reg.names.has(fn)) result.missingFunctions.push(`registry.${fn}`);
    }
    if (attesterId) {
      const att = await exportedFunctions(server, attesterId);
      result.attesterWasmHash = att.hash;
      for (const fn of ATTESTER_FUNCTIONS) {
        if (!att.names.has(fn)) result.missingFunctions.push(`attester.${fn}`);
      }
    }

    // 2. Bits. The writer is the attester contract when there is one; any address
    // works for the bit check, since simulation records auth instead of enforcing it.
    const writer = attesterId ?? SIMULATION_ACCOUNT;
    const allSeps = bitsOf(SEP_NUMBERS.length);
    const allProbes = bitsOf(PROBE_NAMES.length);
    const sim = (seps: number, probes: number) =>
      simulatePutAnchor(server, registry, networkPassphrase, writer, seps, probes);
    if ((await sim(allSeps, allProbes)) === "unknown_bit") {
      for (const [i, sep] of SEP_NUMBERS.entries()) {
        if ((await sim(1 << i, 0)) === "unknown_bit") result.missingSeps.push(sep);
      }
      for (const [i, probe] of PROBE_NAMES.entries()) {
        if ((await sim(0, 1 << i)) === "unknown_bit") result.missingProbes.push(probe);
      }
      if (result.missingSeps.length === 0 && result.missingProbes.length === 0) {
        // Each bit alone passes but all together do not: report it rather than guess.
        result.missingProbes.push("(combination of current bits)");
      }
    }
  } catch (e) {
    return {
      ...result,
      error: `registry preflight on ${network} could not complete: ${describeError(e)}`,
    };
  }

  const behind: string[] = [];
  if (result.missingSeps.length > 0) {
    behind.push(
      `the registry rejects SEP bits ${result.missingSeps.map((s) => `SEP-${s}`).join(", ")}`,
    );
  }
  if (result.missingProbes.length > 0) {
    behind.push(`the registry rejects probe bits ${result.missingProbes.join(", ")}`);
  }
  if (result.missingFunctions.length > 0) {
    behind.push(`missing functions ${result.missingFunctions.join(", ")}`);
  }
  if (behind.length === 0) return { ...result, ok: true, blocking: false };
  const blocking =
    result.missingSeps.length > 0 ||
    result.missingProbes.length > 0 ||
    result.missingFunctions.some((f) => !NON_BLOCKING_FUNCTIONS.includes(f));
  return {
    ...result,
    blocking,
    error:
      `deployed contracts on ${network} are behind main: ${behind.join("; ")}. ` +
      (blocking
        ? "Attestations would be rejected, so none are submitted. "
        : "Attestations still run without the receive limits. ") +
      `An admin must upgrade: pnpm upgrade:registry, then --contract attester ` +
      `(docs/operations.md, "Registry and attester upgrades").`,
  };
}
