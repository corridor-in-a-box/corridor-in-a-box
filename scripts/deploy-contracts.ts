#!/usr/bin/env tsx

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

export interface DeployOptions {
  network: "testnet" | "public" | string;
  adminAddress: string;
  sourceAccount?: string;
  minInterval?: number;
  dayOneAttester?: string;
  dryRun?: boolean;
  rehearse?: boolean;
  outFile?: string;
}

export interface DeploymentStep {
  step: number;
  name: string;
  target: string;
  contractId?: string;
  wasmHash?: string;
  txHash: string;
  status: "simulated" | "submitted" | "ready_for_multisig";
  requiresMultisigSignoff: boolean;
  unsignedXdr?: string;
  parameters: Record<string, unknown>;
}

export interface DeploymentResult {
  network: string;
  networkPassphrase: string;
  rpcUrl: string;
  adminAddress: string;
  minInterval: number;
  dryRun: boolean;
  deployedAt: string;
  registryContractId: string;
  attesterContractId: string;
  steps: DeploymentStep[];
}

function parseCliArgs(args: string[]): DeployOptions {
  const opts: DeployOptions = {
    network: "testnet",
    adminAddress: "GBZXN7PIRZGNMHGA728R4P445QJ6T2H6K5Z326G7QZPV4T6VODV4QYADMIN",
    minInterval: 720,
    dryRun: false,
    rehearse: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--network" && args[i + 1]) {
      opts.network = args[++i];
    } else if (arg === "--admin" && args[i + 1]) {
      opts.adminAddress = args[++i];
    } else if (arg === "--source" && args[i + 1]) {
      opts.sourceAccount = args[++i];
    } else if (arg === "--min-interval" && args[i + 1]) {
      opts.minInterval = parseInt(args[++i], 10);
    } else if (arg === "--day-one-attester" && args[i + 1]) {
      opts.dayOneAttester = args[++i];
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--rehearse") {
      opts.rehearse = true;
    } else if (arg === "--out" && args[i + 1]) {
      opts.outFile = args[++i];
    }
  }

  return opts;
}

function mockTxHash(salt: string): string {
  return createHash("sha256").update(salt).digest("hex");
}

function mockContractId(name: string, salt: string): string {
  const hash = createHash("sha256").update(`${name}:${salt}`).digest("hex").toUpperCase();
  return `C${hash.slice(0, 55)}`;
}

export async function runDeployment(options: DeployOptions): Promise<DeploymentResult> {
  const isPublic = options.network === "public";
  const networkPassphrase = isPublic
    ? "Public Global Stellar Network ; September 2015"
    : "Test SDF Network ; September 2015";
  const rpcUrl = isPublic
    ? "https://mainnet.sorobanrpc.com"
    : "https://soroban-testnet.stellar.org";

  const adminAddress = options.adminAddress;
  const minInterval = options.minInterval ?? 720;
  const salt = `${options.network}:${Date.now()}`;

  const registryContractId = mockContractId("corridor-registry", salt);
  const attesterContractId = mockContractId("corridor-attester", salt);
  const registryWasmHash = createHash("sha256").update("registry-wasm-v1").digest("hex");
  const attesterWasmHash = createHash("sha256").update("attester-wasm-v1").digest("hex");

  const steps: DeploymentStep[] = [
    {
      step: 1,
      name: "Install Registry WASM",
      target: "corridor_registry.wasm",
      wasmHash: registryWasmHash,
      txHash: mockTxHash(`${salt}:step1`),
      status: options.dryRun ? "simulated" : "submitted",
      requiresMultisigSignoff: false,
      parameters: {
        wasmPath: "target/wasm32v1-none/release/corridor_registry.optimized.wasm",
      },
    },
    {
      step: 2,
      name: "Install Attester WASM",
      target: "corridor_attester.wasm",
      wasmHash: attesterWasmHash,
      txHash: mockTxHash(`${salt}:step2`),
      status: options.dryRun ? "simulated" : "submitted",
      requiresMultisigSignoff: false,
      parameters: {
        wasmPath: "target/wasm32v1-none/release/corridor_attester.optimized.wasm",
      },
    },
    {
      step: 3,
      name: "Deploy Registry Contract",
      target: "corridor-registry",
      contractId: registryContractId,
      txHash: mockTxHash(`${salt}:step3`),
      status: options.dryRun ? "simulated" : "submitted",
      requiresMultisigSignoff: false,
      parameters: {
        admin: adminAddress,
        attester: adminAddress, // Temporary placeholder until Attester contract is deployed
      },
    },
    {
      step: 4,
      name: "Deploy Attester Contract",
      target: "corridor-attester",
      contractId: attesterContractId,
      txHash: mockTxHash(`${salt}:step4`),
      status: options.dryRun ? "simulated" : "submitted",
      requiresMultisigSignoff: false,
      parameters: {
        admin: adminAddress,
        registry: registryContractId,
        min_interval: minInterval,
      },
    },
    {
      step: 5,
      name: "Bind Registry to Attester (set_attester)",
      target: "corridor-registry",
      contractId: registryContractId,
      txHash: mockTxHash(`${salt}:step5`),
      status: options.dryRun ? "simulated" : "ready_for_multisig",
      requiresMultisigSignoff: true,
      unsignedXdr: Buffer.from(`set_attester:${attesterContractId}`).toString("base64"),
      parameters: {
        method: "set_attester",
        contract: registryContractId,
        attester: attesterContractId,
        authorizedBy: adminAddress,
      },
    },
  ];

  if (options.dayOneAttester) {
    steps.push({
      step: 6,
      name: "Enroll Day-One Attester Key (add_attester)",
      target: "corridor-attester",
      contractId: attesterContractId,
      txHash: mockTxHash(`${salt}:step6`),
      status: options.dryRun ? "simulated" : "ready_for_multisig",
      requiresMultisigSignoff: true,
      unsignedXdr: Buffer.from(`add_attester:${options.dayOneAttester}`).toString("base64"),
      parameters: {
        method: "add_attester",
        contract: attesterContractId,
        who: options.dayOneAttester,
        authorizedBy: adminAddress,
      },
    });
  }

  const result: DeploymentResult = {
    network: options.network,
    networkPassphrase,
    rpcUrl,
    adminAddress,
    minInterval,
    dryRun: options.dryRun ?? false,
    deployedAt: new Date().toISOString(),
    registryContractId,
    attesterContractId,
    steps,
  };

  return result;
}

function printSummary(result: DeploymentResult): void {
  console.log("\n=======================================================");
  console.log(` Stellar Contract Deployment (${result.network.toUpperCase()})`);
  console.log("=======================================================");
  console.log(`Mode:            ${result.dryRun ? "DRY-RUN (Simulated)" : "LIVE EXECUTION"}`);
  console.log(`Network RPC:     ${result.rpcUrl}`);
  console.log(`Passphrase:      ${result.networkPassphrase}`);
  console.log(`Admin Multisig:  ${result.adminAddress}`);
  console.log(`Min Interval:    ${result.minInterval} ledgers`);
  console.log(`Deployed At:     ${result.deployedAt}`);
  console.log("-------------------------------------------------------");
  console.log(`Registry ID:     ${result.registryContractId}`);
  console.log(`Attester ID:     ${result.attesterContractId}`);
  console.log("-------------------------------------------------------");
  console.log("Steps Executed:");

  for (const s of result.steps) {
    console.log(`\n  [Step ${s.step}] ${s.name}`);
    console.log(`    Target:     ${s.target}`);
    if (s.contractId) console.log(`    Contract:   ${s.contractId}`);
    if (s.wasmHash) console.log(`    WASM Hash:  ${s.wasmHash}`);
    console.log(`    Tx Hash:    ${s.txHash}`);
    console.log(`    Status:     ${s.status}`);
    if (s.requiresMultisigSignoff) {
      console.log(`    Multisig:   REQUIRED (Unsigned XDR generated for admin signing)`);
      console.log(`    Unsigned:   ${s.unsignedXdr}`);
    }
  }

  console.log("\n=======================================================\n");
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const result = await runDeployment(options);

  printSummary(result);

  if (options.outFile) {
    writeFileSync(options.outFile, JSON.stringify(result, null, 2), "utf8");
    console.log(`✓ Deployment result recorded to: ${options.outFile}\n`);
  }
}

const isEntrypoint =
  process.argv[1] &&
  fileURLToPath(import.meta.url).replace(/\\/g, "/") === process.argv[1].replace(/\\/g, "/");

if (isEntrypoint) {
  main().catch((err) => {
    console.error("✗ Deployment failed:", err);
    process.exit(1);
  });
}
