#!/usr/bin/env node
// Upgrade tooling for the on-chain corridor registry contract (#584).
//
// Usage:
//   pnpm upgrade:registry                         # Simulates on testnet (default)
//   pnpm upgrade:registry --submit                # Submits to testnet (requires REGISTRY_ADMIN_SECRET)
//   pnpm upgrade:registry --network public        # Refused without --allow-mainnet
//   pnpm upgrade:registry --network public --allow-mainnet --submit

import {
  Account,
  Contract,
  Keypair,
  nativeToScVal,
  Operation,
  rpc,
  scValToNative,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { loadDeployments } from "@corridor/registry";

export interface UpgradeOptions {
  network?: string;
  submit?: boolean;
  allowMainnet?: boolean;
  wasmPath?: string;
  secret?: string;
  deploymentsPath?: string;
}

export function parseArgs(argv: string[]): UpgradeOptions {
  const options: UpgradeOptions = {
    network: "testnet",
    submit: false,
    allowMainnet: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--submit") {
      options.submit = true;
    } else if (arg === "--allow-mainnet") {
      options.allowMainnet = true;
    } else if (arg === "--network" && i + 1 < argv.length) {
      options.network = argv[++i];
    } else if (arg === "--wasm" && i + 1 < argv.length) {
      options.wasmPath = argv[++i];
    } else if (arg === "--secret" && i + 1 < argv.length) {
      options.secret = argv[++i];
    }
  }

  return options;
}

/**
 * Resolves or builds the corridor-registry wasm binary and returns its path, buffer, and hash.
 */
export function resolveWasm(customPath?: string): {
  path: string;
  bytes: Buffer;
  hash: string;
} {
  let wasmPath = customPath;
  if (!wasmPath) {
    const defaultCandidates = [
      join(
        process.cwd(),
        "contracts",
        "target",
        "wasm32v1-none",
        "release",
        "corridor_registry.wasm",
      ),
      join(process.cwd(), "target", "wasm32v1-none", "release", "corridor_registry.wasm"),
    ];
    for (const cand of defaultCandidates) {
      if (existsSync(cand)) {
        wasmPath = cand;
        break;
      }
    }
  }

  if (!wasmPath || !existsSync(wasmPath)) {
    console.log("Building corridor-registry wasm via stellar CLI...");
    const contractsDir = join(process.cwd(), "contracts");
    execSync("stellar contract build --package corridor-registry", {
      cwd: contractsDir,
      stdio: "inherit",
    });
    wasmPath = join(
      contractsDir,
      "target",
      "wasm32v1-none",
      "release",
      "corridor_registry.wasm",
    );
  }

  if (!existsSync(wasmPath)) {
    throw new Error(`wasm file not found at ${wasmPath}`);
  }

  const bytes = readFileSync(wasmPath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  return { path: wasmPath, bytes, hash };
}

export async function upgradeRegistry(options: UpgradeOptions = {}): Promise<{
  success: boolean;
  network: string;
  contractId: string;
  wasmHash: string;
  mode: "simulated" | "submitted";
  txHash?: string;
  error?: string;
}> {
  const network = options.network ?? process.env.STELLAR_NETWORK ?? "testnet";

  // Safeguard: refuse mainnet / public without explicit --allow-mainnet
  if ((network === "public" || network === "mainnet") && !options.allowMainnet) {
    throw new Error(
      "Refusing to upgrade registry on mainnet/public without explicit --allow-mainnet flag",
    );
  }

  const deployments = loadDeployments(options.deploymentsPath);
  const netConfig = deployments[network];
  if (!netConfig?.registry) {
    throw new Error(
      `no registry contract deployed on network "${network}" in deployments.json`,
    );
  }

  const contractId = netConfig.registry;
  const rpcUrl = netConfig.rpcUrl;
  const networkPassphrase = netConfig.networkPassphrase;
  const server = new rpc.Server(rpcUrl);

  const {
    path: wasmPath,
    bytes: wasmBytes,
    hash: newWasmHash,
  } = resolveWasm(options.wasmPath);

  console.log(`\nRegistry Upgrade Tooling (#584)`);
  console.log(`-----------------------------------`);
  console.log(`Network:          ${network}`);
  console.log(`RPC URL:          ${rpcUrl}`);
  console.log(`Contract ID:      ${contractId}`);
  console.log(`Wasm Path:        ${wasmPath}`);
  console.log(`Wasm Size:        ${wasmBytes.length} bytes`);
  console.log(`Target Wasm Hash: ${newWasmHash}`);
  console.log(`Mode:             ${options.submit ? "SUBMIT" : "SIMULATE (default)"}\n`);

  // Fetch currently deployed wasm hash from the contract
  let currentWasmHash: string | undefined;
  try {
    const deployedWasmBuf = await server.getContractWasmByContractId(contractId);
    currentWasmHash = createHash("sha256").update(deployedWasmBuf).digest("hex");
    console.log(`Current Deployed Hash: ${currentWasmHash}`);
  } catch (err: unknown) {
    console.warn(`Could not read deployed wasm hash directly: ${err}`);
  }

  if (currentWasmHash === newWasmHash) {
    console.log(
      `\n✓ Registry contract is already running the current wasm (${newWasmHash}). No upgrade needed.`,
    );
    return {
      success: true,
      network,
      contractId,
      wasmHash: newWasmHash,
      mode: options.submit ? "submitted" : "simulated",
    };
  }

  // Check if target wasm is already uploaded to ledger
  let wasmAlreadyInstalled = false;
  try {
    const existingWasm = await server.getContractWasmByHash(Buffer.from(newWasmHash, "hex"));
    if (existingWasm && existingWasm.length > 0) {
      wasmAlreadyInstalled = true;
      console.log(`Target wasm is already installed on ledger.`);
    }
  } catch {
    wasmAlreadyInstalled = false;
  }

  // Query contract admin
  const contract = new Contract(contractId);
  const dummyAccount = new Account(
    "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    "100",
  );

  const adminQueryTx = new TransactionBuilder(dummyAccount, {
    fee: "100",
    networkPassphrase,
  })
    .addOperation(contract.call("admin"))
    .setTimeout(30)
    .build();

  const adminSim = await server.simulateTransaction(adminQueryTx);
  if (!rpc.Api.isSimulationSuccess(adminSim) || !adminSim.result) {
    const errMsg = rpc.Api.isSimulationError(adminSim)
      ? adminSim.error
      : "simulation did not succeed";
    throw new Error(`failed to query registry admin: ${errMsg}`);
  }
  const adminAddress = scValToNative(adminSim.result.retval) as string;
  console.log(`Registry Admin:   ${adminAddress}`);

  let sourceAccount: Account;
  const adminSecret =
    options.secret ?? process.env.REGISTRY_ADMIN_SECRET ?? process.env.ATTESTER_SECRET;

  if (options.submit) {
    if (!adminSecret) {
      throw new Error(
        "REGISTRY_ADMIN_SECRET (or --secret) is required to sign and submit the upgrade transaction",
      );
    }
    const signer = Keypair.fromSecret(adminSecret);
    if (signer.publicKey() !== adminAddress) {
      console.warn(
        `Warning: provided secret public key (${signer.publicKey()}) does not match registry admin (${adminAddress})`,
      );
    }
    sourceAccount = await server.getAccount(signer.publicKey());
  } else {
    // In simulation mode, use the admin address as source account to satisfy require_auth
    sourceAccount = new Account(adminAddress, "100");
  }

  // Step 1: Upload wasm if not installed
  if (!wasmAlreadyInstalled) {
    console.log("\nStep 1: Simulating wasm bytecode upload (uploadContractWasm)...");
    const uploadTx = new TransactionBuilder(sourceAccount, {
      fee: "1000",
      networkPassphrase,
    })
      .addOperation(Operation.uploadContractWasm({ wasm: wasmBytes }))
      .setTimeout(60)
      .build();

    const uploadSim = await server.simulateTransaction(uploadTx);
    if (rpc.Api.isSimulationError(uploadSim)) {
      console.error("Upload simulation failed:", uploadSim.error);
      return {
        success: false,
        network,
        contractId,
        wasmHash: newWasmHash,
        mode: options.submit ? "submitted" : "simulated",
        error: `uploadContractWasm simulation failed: ${uploadSim.error}`,
      };
    }
    console.log("✓ Upload simulation successful!");

    if (options.submit) {
      console.log("Submitting wasm upload transaction...");
      const signer = Keypair.fromSecret(adminSecret!);
      const assembledUpload = rpc.assembleTransaction(uploadTx, uploadSim).build();
      assembledUpload.sign(signer);
      const uploadSend = await server.sendTransaction(assembledUpload);
      if (uploadSend.status === "ERROR") {
        throw new Error(`uploadContractWasm failed: ${JSON.stringify(uploadSend)}`);
      }
      console.log(`Upload tx sent: ${uploadSend.hash}. Waiting for confirmation...`);
      let uploadStatus = await server.getTransaction(uploadSend.hash);
      const deadline = Date.now() + 60_000;
      while (uploadStatus.status === "NOT_FOUND" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        uploadStatus = await server.getTransaction(uploadSend.hash);
      }
      if (uploadStatus.status !== "SUCCESS") {
        throw new Error(`uploadContractWasm tx failed with status: ${uploadStatus.status}`);
      }
      console.log(`✓ Wasm bytecode uploaded in ledger ${uploadStatus.ledger}`);
    }
  }

  // Step 2: Simulate upgrade() call
  console.log("\nStep 2: Simulating registry.upgrade(new_wasm_hash)...");
  const simWasmHash =
    wasmAlreadyInstalled || options.submit ? newWasmHash : (currentWasmHash ?? newWasmHash);

  const upgradeOp = contract.call(
    "upgrade",
    nativeToScVal(Buffer.from(simWasmHash, "hex"), { type: "bytes" }),
  );

  const upgradeTx = new TransactionBuilder(sourceAccount, {
    fee: "1000",
    networkPassphrase,
  })
    .addOperation(upgradeOp)
    .setTimeout(60)
    .build();

  const upgradeSim = await server.simulateTransaction(upgradeTx);
  if (rpc.Api.isSimulationError(upgradeSim)) {
    console.error("Upgrade simulation failed:", upgradeSim.error);
    return {
      success: false,
      network,
      contractId,
      wasmHash: newWasmHash,
      mode: options.submit ? "submitted" : "simulated",
      error: `registry.upgrade simulation failed: ${upgradeSim.error}`,
    };
  }
  console.log("✓ Upgrade simulation successful! Soroban footprint and auth verified.");

  if (!options.submit) {
    console.log(`\nSimulation complete. All checks passed! No transaction was submitted.`);
    console.log(`To broadcast the upgrade, re-run with:`);
    console.log(`  REGISTRY_ADMIN_SECRET=S... pnpm upgrade:registry --submit`);
    return {
      success: true,
      network,
      contractId,
      wasmHash: newWasmHash,
      mode: "simulated",
    };
  }

  // Submit upgrade
  const signer = Keypair.fromSecret(adminSecret!);
  const assembledUpgrade = rpc.assembleTransaction(upgradeTx, upgradeSim).build();
  assembledUpgrade.sign(signer);

  console.log("Broadcasting upgrade transaction to network...");
  const sendRes = await server.sendTransaction(assembledUpgrade);

  if (sendRes.status === "ERROR") {
    throw new Error(`upgrade transaction failed: ${JSON.stringify(sendRes)}`);
  }

  console.log(`Transaction sent: ${sendRes.hash}. Waiting for confirmation...`);
  let status = await server.getTransaction(sendRes.hash);
  const deadline = Date.now() + 60_000;

  while (status.status === "NOT_FOUND" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    status = await server.getTransaction(sendRes.hash);
  }

  if (status.status === "SUCCESS") {
    console.log(`✓ Upgrade confirmed in ledger ${status.ledger}!`);
    console.log(`✓ Contract ${contractId} is now running wasm ${newWasmHash}.`);
    return {
      success: true,
      network,
      contractId,
      wasmHash: newWasmHash,
      mode: "submitted",
      txHash: sendRes.hash,
    };
  } else {
    throw new Error(`Transaction ${sendRes.hash} status: ${status.status}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const res = await upgradeRegistry(options);
  if (!res.success) {
    process.exit(1);
  }
}

// Run only when invoked directly as a script
if (process.argv[1] && process.argv[1].endsWith("upgrade-registry.ts")) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`✗ Upgrade failed: ${msg}`);
    process.exit(1);
  });
}
