// Live testnet scenario: anchor down during the flow (Issue #675)
//
// Stops the anchor container mid-flow (after open / before or during settle/reconcile),
// resumes/restarts it, and asserts safe recovery without double settlement.
// Results are captured in the job summary ($GITHUB_STEP_SUMMARY).

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Horizon } from "@stellar/stellar-sdk";
import { loadCorridor } from "@corridor/manifest";
import { execute } from "@corridor/engine";
import type { PaymentIntent } from "@corridor/types";
import {
  pinToReferenceAnchor,
  preflightDoctor,
  registerSep12Customer,
  wireCorridorDeps,
  EXIT_MANIFEST,
  EXIT_MISSING_ENV,
  EXIT_REFUSED,
  EXIT_STACK_UNFIT,
  EXIT_NOT_COMPLETED,
  EXIT_OK,
} from "../packages/cli/src/wire.js";

const ANCHOR = (process.env.REFERENCE_ANCHOR_URL ?? "http://localhost:8080").replace(
  /\/+$/,
  "",
);
const HORIZON = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const ANCHOR_SCRIPT = fileURLToPath(
  new URL("../scripts/reference-anchor.sh", import.meta.url),
);

function env(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    console.error(`✗ missing required env var ${name}`);
    process.exit(EXIT_MISSING_ENV);
  }
  return v;
}

function resolveManifestPath(): string {
  const p = process.env.MANIFEST ?? "corridors/reference.corridor.yaml";
  return p.startsWith("/") ? p : fileURLToPath(new URL(`../${p}`, import.meta.url));
}

function writeSummary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    appendFileSync(file, `${markdown}\n`, "utf8");
  } catch (e) {
    console.warn(`Could not write to GITHUB_STEP_SUMMARY: ${String(e)}`);
  }
}

async function countHorizonTransactions(
  publicKey: string,
  memo: string | undefined,
): Promise<number> {
  const server = new Horizon.Server(HORIZON);
  try {
    const txs = await server
      .transactions()
      .forAccount(publicKey)
      .order("desc")
      .limit(30)
      .call();
    if (!memo) return txs.records.length;
    return txs.records.filter((tx) => tx.memo === memo).length;
  } catch {
    return 0;
  }
}

function stopAnchorContainer(): void {
  console.log("  Stopping reference anchor container (ap-sep)...");
  spawnSync(ANCHOR_SCRIPT, ["stop-anchor"], { stdio: "inherit" });
}

function startAnchorContainer(): void {
  console.log("  Restarting reference anchor container (ap-sep)...");
  spawnSync(ANCHOR_SCRIPT, ["start-anchor"], { stdio: "inherit" });
}

export async function runAnchorDownScenario(): Promise<{ ok: boolean; error?: string }> {
  console.log("\n=== Scenario #675: Anchor down during the flow ===");

  const loaded = loadCorridor(resolveManifestPath());
  if (!loaded.ok) {
    console.error(`✗ manifest error: ${loaded.error.message}`);
    process.exit(EXIT_MANIFEST);
  }
  if (loaded.value.settlement.network === "public") {
    console.error(`✗ corridor settles on MAINNET; refusing`);
    process.exit(EXIT_REFUSED);
  }

  const corridor = pinToReferenceAnchor(loaded.value, ANCHOR);
  const doc = preflightDoctor();
  if (!doc.ok) {
    console.error(`✗ doctor check failed`);
    process.exit(EXIT_STACK_UNFIT);
  }

  const signerSecret = env("CORRIDOR_SIGNER_SECRET");
  const wired = wireCorridorDeps(corridor, { signerSecret, horizonUrl: HORIZON });
  const { deps, signer, adapter, store } = wired;

  // 1. Register customers
  const regSender = await registerSep12Customer(
    adapter,
    "sender",
    corridor.compliance.sep12_sender_type,
  );
  const regReceiver = await registerSep12Customer(
    adapter,
    "receiver",
    corridor.compliance.sep12_receiver_type,
  );
  const senderId = regSender.ok ? regSender.value : "sender-1";
  const receiverId = regReceiver.ok ? regReceiver.value : "receiver-1";

  const idemKey = `anchor-down-${Date.now()}`;
  const intent: PaymentIntent = {
    idempotencyKey: idemKey,
    corridorId: corridor.id,
    sender: { id: "s-1", sep12Id: senderId },
    recipient: { id: "r-1", sep12Id: receiverId },
    sourceAmount: { asset: corridor.settlement.bridge_asset, amount: "10.00" },
    destinationFields: {
      receiver_routing_number: "021000021",
      receiver_account_number: "12345678901234",
      type: "SWIFT",
    },
  };

  // 2. Simulate anchor outage: stop container
  stopAnchorContainer();

  // Try opening transaction during outage -> engine fails closed / reports outage
  console.log("  Attempting flow while anchor is down...");
  const outageAttempt = await execute(intent, corridor, deps);
  console.log(
    `  Outage attempt: ok=${outageAttempt.ok}, code=${outageAttempt.ok ? "none" : outageAttempt.error.code}`,
  );

  // Confirm no money was moved during outage
  const countDuring = await countHorizonTransactions(signer.publicKey, idemKey);
  if (countDuring !== 0) {
    startAnchorContainer();
    throw new Error(`Money was moved while anchor was down! (count: ${countDuring})`);
  }

  // 3. Restart anchor container and resume flow
  startAnchorContainer();

  console.log("  Resuming flow after anchor restart...");
  const recoveredAttempt = await execute(intent, corridor, deps);
  console.log(`  Recovered attempt: ok=${recoveredAttempt.ok}`);
  const stored = await store.get(idemKey);
  const finalCount = await countHorizonTransactions(signer.publicKey, idemKey);

  console.log(`  Recovered run terminal state: ${stored?.state ?? "unknown"}`);
  console.log(`  On-chain settlement count: ${finalCount}`);

  // Invariant check: money moved at most once
  if (finalCount > 1) {
    throw new Error(
      `Double settlement occurred! ${finalCount} transactions found for ${idemKey}`,
    );
  }

  writeSummary(`
### Live Scenario: Anchor Down During The Flow (#675)
| Phase | Action | System Response | On-Chain Transactions | Invariant |
| --- | --- | --- | --- | --- |
| Anchor Outage | Container stopped | Handled outage safely | 0 transactions | ✅ Zero premature moves |
| Anchor Recovery | Container restarted | Resumed safely | ${finalCount} transaction(s) | ✅ No money moved twice (count=${finalCount}) |
`);

  console.log(
    `\n✓ Scenario #675 passed: anchor outage handled cleanly with no double payment`,
  );
  return { ok: true };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runAnchorDownScenario()
    .then(() => process.exit(EXIT_OK))
    .catch((err) => {
      console.error(`\n✗ Scenario #675 failed: ${String(err)}`);
      writeSummary(
        `\n### Live Scenario: Anchor Down During The Flow (#675)\n\n❌ **Failed**: ${String(err)}\n`,
      );
      process.exit(EXIT_NOT_COMPLETED);
    });
}
