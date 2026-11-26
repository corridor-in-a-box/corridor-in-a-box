// Upgrade the deployed registry (or attester) contract to the wasm built from this
// checkout (#584). Runbook: docs/operations.md, "Registry and attester upgrades".
//
//   pnpm upgrade:registry                               # simulate, testnet, registry
//   pnpm upgrade:registry --contract attester           # simulate, testnet, attester
//   REGISTRY_ADMIN_SECRET=S... pnpm upgrade:registry --submit
//   pnpm upgrade:registry --network public --allow-mainnet [--submit]
//
// It builds the wasm with the Stellar CLI (unless --wasm names one), uploads it and
// calls the contract's admin-only `upgrade(new_wasm_hash)`. It SIMULATES by default
// and needs no key for that; only `--submit` signs and sends, with the admin secret
// read from REGISTRY_ADMIN_SECRET (never from the command line, where it would land
// in shell history and the process list). The network defaults to testnet and the
// public network is refused without --allow-mainnet. The secret is never printed.
//
// Upgrade the registry first and the attester second (docs/registry-metadata.md),
// so an attester never relays to a registry function that does not exist yet.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Account,
  Contract,
  Keypair,
  Operation,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { loadDeployments, type DeploymentEntry } from "@corridor/registry";

type ContractName = "registry" | "attester";

export interface UpgradeOptions {
  network: string;
  contract: ContractName;
  submit: boolean;
  allowMainnet: boolean;
  wasmPath?: string;
}

const PACKAGES: Record<ContractName, string> = {
  registry: "corridor-registry",
  attester: "corridor-attester",
};

const USAGE =
  "usage: pnpm upgrade:registry [--contract registry|attester] [--network testnet|public] " +
  "[--allow-mainnet] [--wasm path] [--submit]";

export function parseArgs(argv: readonly string[]): UpgradeOptions {
  const o: UpgradeOptions = {
    network: "testnet",
    contract: "registry",
    submit: false,
    allowMainnet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--"))
        throw new Error(`${arg} needs a value\n${USAGE}`);
      return v;
    };
    if (arg === "--submit") o.submit = true;
    else if (arg === "--allow-mainnet") o.allowMainnet = true;
    else if (arg === "--network") o.network = value();
    else if (arg === "--wasm") o.wasmPath = value();
    else if (arg === "--contract") {
      const c = value();
      if (c !== "registry" && c !== "attester")
        throw new Error(`unknown contract ${c}\n${USAGE}`);
      o.contract = c;
    } else throw new Error(`unknown argument ${String(arg)}\n${USAGE}`);
  }
  return o;
}

function buildWasm(
  contract: ContractName,
  wasmPath?: string,
): { path: string; bytes: Buffer } {
  const contractsDir = join(process.cwd(), "contracts");
  const path =
    wasmPath ??
    join(
      contractsDir,
      "target",
      "wasm32v1-none",
      "release",
      `${PACKAGES[contract].replace("-", "_")}.wasm`,
    );
  if (!wasmPath) {
    console.log(`Building ${PACKAGES[contract]} with the Stellar CLI...`);
    execFileSync("stellar", ["contract", "build", "--package", PACKAGES[contract]], {
      cwd: contractsDir,
      stdio: "inherit",
    });
  }
  if (!existsSync(path)) throw new Error(`wasm not found at ${path}`);
  return { path, bytes: readFileSync(path) };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function waitFor(
  server: rpc.Server,
  hash: string,
): Promise<rpc.Api.GetTransactionResponse> {
  const deadline = Date.now() + 90_000;
  let res = await server.getTransaction(hash);
  while (res.status === rpc.Api.GetTransactionStatus.NOT_FOUND && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2_000));
    res = await server.getTransaction(hash);
  }
  return res;
}

async function simulate(
  server: rpc.Server,
  source: Account,
  passphrase: string,
  op: xdr.Operation,
): Promise<{
  tx: ReturnType<TransactionBuilder["build"]>;
  sim: rpc.Api.SimulateTransactionResponse;
}> {
  const tx = new TransactionBuilder(source, { fee: "1000000", networkPassphrase: passphrase })
    .addOperation(op)
    .setTimeout(120)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`simulation failed: ${sim.error}`);
  return { tx, sim };
}

async function send(
  server: rpc.Server,
  tx: ReturnType<TransactionBuilder["build"]>,
  sim: rpc.Api.SimulateTransactionResponse,
  signer: Keypair,
  what: string,
): Promise<rpc.Api.GetSuccessfulTransactionResponse & { hash: string }> {
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(signer);
  const sent = await server.sendTransaction(prepared);
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
    throw new Error(`${what} was not accepted (${sent.status})`);
  }
  const done = await waitFor(server, sent.hash);
  if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`${what} ${sent.hash} ended ${done.status}`);
  }
  return { ...done, hash: sent.hash };
}

export async function upgradeContract(o: UpgradeOptions): Promise<void> {
  if ((o.network === "public" || o.network === "mainnet") && !o.allowMainnet) {
    throw new Error("refusing the public network without --allow-mainnet");
  }
  const entry = loadDeployments()[o.network] as DeploymentEntry | undefined;
  const contractId = entry?.[o.contract];
  if (!entry || typeof contractId !== "string") {
    throw new Error(
      `no ${o.contract} deployed on "${o.network}" in contracts/deployments.json`,
    );
  }

  const server = new rpc.Server(entry.rpcUrl);
  const contract = new Contract(contractId);
  const { path, bytes } = buildWasm(o.contract, o.wasmPath);
  const newHash = sha256(bytes);
  const currentHash = sha256(await server.getContractWasmByContractId(contractId));

  console.log(`network      ${o.network}`);
  console.log(`${o.contract.padEnd(12)} ${contractId}`);
  console.log(`deployed     ${currentHash}`);
  console.log(`built        ${newHash}  (${path}, ${bytes.length} bytes)`);
  console.log(`mode         ${o.submit ? "SUBMIT" : "simulate (add --submit to send)"}`);
  if (currentHash === newHash) {
    console.log(`✓ ${o.contract} already runs this wasm; nothing to do.`);
    return;
  }

  // The admin, read from the contract itself rather than trusted from config.
  const reader = new Account(Keypair.random().publicKey(), "0");
  const { sim: adminSim } = await simulate(
    server,
    reader,
    entry.networkPassphrase,
    contract.call("admin"),
  );
  if (!rpc.Api.isSimulationSuccess(adminSim) || !adminSim.result) {
    throw new Error("could not read the contract admin");
  }
  const admin = String(scValToNative(adminSim.result.retval));
  console.log(`admin        ${admin}`);

  let signer: Keypair | undefined;
  if (o.submit) {
    const secret = process.env.REGISTRY_ADMIN_SECRET;
    if (!secret)
      throw new Error("--submit needs REGISTRY_ADMIN_SECRET (the contract admin's key)");
    signer = Keypair.fromSecret(secret);
    if (signer.publicKey() !== admin) {
      throw new Error(
        `REGISTRY_ADMIN_SECRET is ${signer.publicKey()}, not the admin ${admin}`,
      );
    }
  }
  // Simulating as the admin's account lets the admin's require_auth be recorded.
  const source = signer ? await server.getAccount(admin) : new Account(admin, "0");

  // 1. Upload the wasm, unless the ledger already has it.
  let installed = true;
  try {
    await server.getContractWasmByHash(Buffer.from(newHash, "hex"));
  } catch {
    installed = false;
  }
  if (installed) {
    console.log("1. upload: the ledger already has this wasm");
  } else {
    const upload = await simulate(
      server,
      source,
      entry.networkPassphrase,
      Operation.uploadContractWasm({ wasm: bytes }),
    );
    console.log("1. upload: simulation ok");
    if (signer) {
      const done = await send(server, upload.tx, upload.sim, signer, "upload");
      console.log(`   uploaded in ledger ${done.ledger} (tx ${done.hash})`);
      installed = true;
    }
  }

  // 2. upgrade(new_wasm_hash). Simulating it with a hash the ledger does not have yet
  // would fail for that reason alone, so a dry run before the upload checks the
  // admin's authorisation with the current hash instead and says so.
  const target = installed ? newHash : currentHash;
  const upgrade = await simulate(
    server,
    source,
    entry.networkPassphrase,
    contract.call("upgrade", xdr.ScVal.scvBytes(Buffer.from(target, "hex"))),
  );
  console.log(
    installed
      ? "2. upgrade: simulation ok"
      : "2. upgrade: simulation ok (admin auth checked with the current hash; the new wasm is not uploaded yet)",
  );
  if (!signer) {
    console.log("✓ simulation complete; nothing was sent.");
    return;
  }
  const done = await send(server, upgrade.tx, upgrade.sim, signer, "upgrade");
  const day = new Date(Number(done.createdAt) * 1000).toISOString().slice(0, 10);
  console.log(`✓ ${o.contract} now runs ${newHash} (ledger ${done.ledger}).`);
  console.log("Append this to contracts/deployments.json under upgrades:");
  console.log(
    JSON.stringify(
      {
        contract: o.contract,
        wasmHash: newHash,
        txHash: done.hash,
        date: day,
        ledger: done.ledger,
      },
      null,
      2,
    ),
  );
}

upgradeContract(parseArgs(process.argv.slice(2))).catch((err: unknown) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
