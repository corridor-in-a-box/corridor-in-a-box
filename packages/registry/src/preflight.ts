// Preflight check for the on-chain registry contract (RFC / #584).
//
// Detects whether the deployed registry contract is behind `main`'s PROBE_NAMES
// or missing required query functions before running attestation jobs.
//
// Fails once with a clear actionable error instead of failing per-anchor during
// nightly attestations.

import {
  Account,
  Contract,
  rpc,
  nativeToScVal,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { PROBE_NAMES, RegistryContractError, contractErrorCode } from "./index";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface DeploymentsConfig {
  [network: string]: {
    networkPassphrase: string;
    rpcUrl: string;
    registry: string | null;
    attester: string | null;
  };
}

export interface PreflightOptions {
  network?: string;
  contractId?: string;
  rpcUrl?: string;
  networkPassphrase?: string;
  server?: rpc.Server;
  deploymentsPath?: string;
  probesToCheck?: readonly string[];
}

export interface PreflightResult {
  ok: boolean;
  network: string;
  contractId: string;
  supportedProbes: string[];
  missingProbes: string[];
  missingFunctions: string[];
  error?: string;
}

const DUMMY_ACCOUNT_ID = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/**
 * Loads deployments config from deployments.json.
 */
export function loadDeployments(customPath?: string): DeploymentsConfig {
  const p = customPath ?? join(process.cwd(), "contracts", "deployments.json");
  const content = readFileSync(p, "utf-8");
  return JSON.parse(content) as DeploymentsConfig;
}

/**
 * Verifies that the deployed registry contract supports all current PROBE_NAMES
 * and required queries without failing with UnknownBit (#4) or MissingValue.
 */
export async function preflightRegistry(
  options: PreflightOptions = {},
): Promise<PreflightResult> {
  const network = options.network ?? process.env.STELLAR_NETWORK ?? "testnet";
  let contractId = options.contractId;
  let rpcUrl = options.rpcUrl;
  let networkPassphrase = options.networkPassphrase;

  if (!contractId || !rpcUrl || !networkPassphrase) {
    const deployments = loadDeployments(options.deploymentsPath);
    const netConfig = deployments[network];
    if (!netConfig?.registry) {
      return {
        ok: false,
        network,
        contractId: contractId ?? "unknown",
        supportedProbes: [],
        missingProbes: [],
        missingFunctions: [],
        error: `no registry contract deployed on network "${network}" in deployments.json`,
      };
    }
    contractId = contractId ?? netConfig.registry;
    rpcUrl = rpcUrl ?? netConfig.rpcUrl;
    networkPassphrase = networkPassphrase ?? netConfig.networkPassphrase;
  }

  const server = options.server ?? new rpc.Server(rpcUrl);
  const contract = new Contract(contractId);
  const dummyAccount = new Account(DUMMY_ACCOUNT_ID, "100");

  const probesToCheck = options.probesToCheck ?? PROBE_NAMES;
  const supportedProbes: string[] = [];
  const missingProbes: string[] = [];
  const missingFunctions: string[] = [];

  // 1. Check probe bits support by simulating put_anchor with each probe bit
  for (let i = 0; i < probesToCheck.length; i++) {
    const probeName = probesToCheck[i]!;
    const bitVal = 1 << i;

    const op = contract.call(
      "put_anchor",
      nativeToScVal("preflight-check.example", { type: "string" }),
      nativeToScVal(1, { type: "u32" }), // SEP-1
      nativeToScVal(Buffer.alloc(32), { type: "bytes" }),
      nativeToScVal(bitVal, { type: "u32" }), // probes_run
      nativeToScVal(0, { type: "u32" }), // probes_passed
      nativeToScVal(DUMMY_ACCOUNT_ID, { type: "address" }),
    );

    const tx = new TransactionBuilder(dummyAccount, {
      fee: "100",
      networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    try {
      const sim = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) {
        const errCode = contractErrorCode(sim.error);
        if (errCode === RegistryContractError.UnknownBit) {
          missingProbes.push(probeName);
        } else {
          // Other simulation errors (e.g. auth failed, not initialized) mean the bit was accepted by validation
          supportedProbes.push(probeName);
        }
      } else {
        supportedProbes.push(probeName);
      }
    } catch (err: unknown) {
      const errCode = contractErrorCode(err);
      if (errCode === RegistryContractError.UnknownBit) {
        missingProbes.push(probeName);
      } else {
        supportedProbes.push(probeName);
      }
    }
  }

  // 2. Check function exports (e.g. serves_sep6, get_meta)
  const functionsToCheck = ["serves_sep6", "get_meta", "receives_asset"];
  for (const fnName of functionsToCheck) {
    let op;
    if (fnName === "serves_sep6" || fnName === "get_meta") {
      op = contract.call(fnName, nativeToScVal("preflight-check.example", { type: "string" }));
    } else {
      op = contract.call(
        fnName,
        nativeToScVal("preflight-check.example", { type: "string" }),
        nativeToScVal("USDC", { type: "string" }),
      );
    }

    const tx = new TransactionBuilder(dummyAccount, {
      fee: "100",
      networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    try {
      const sim = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) {
        const msg = sim.error ?? "";
        if (msg.includes("MissingValue") || msg.includes("not found")) {
          missingFunctions.push(fnName);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("MissingValue") || msg.includes("not found")) {
        missingFunctions.push(fnName);
      }
    }
  }

  const isBehind = missingProbes.length > 0 || missingFunctions.length > 0;
  if (isBehind) {
    return {
      ok: false,
      network,
      contractId,
      supportedProbes,
      missingProbes,
      missingFunctions,
      error: `deployed registry contract on ${network} is behind main: upgrade() the registry to current PROBE_NAMES before running attestation (run pnpm upgrade:registry)`,
    };
  }

  return {
    ok: true,
    network,
    contractId,
    supportedProbes,
    missingProbes: [],
    missingFunctions: [],
  };
}
