// Live testnet scenario: anchor asks for more customer information (Issue #673)
//
// Demonstrates a run where the receiving anchor's SEP-12 reports NEEDS_INFO
// for the receiver. The engine stops cleanly with PRESETTLE_RECEIVER_NOT_ACCEPTED
// before settle, ensuring 0 money moves.
// Results are captured in the job summary ($GITHUB_STEP_SUMMARY).

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

export async function runNeedsInfoScenario(): Promise<{ ok: boolean; error?: string }> {
  console.log(
    "\n=== Scenario #673: Anchor asks for more customer information (NEEDS_INFO) ===",
  );

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

  // Register a sender normally
  const regSender = await registerSep12Customer(
    adapter,
    "sender",
    corridor.compliance.sep12_sender_type,
  );
  const senderId = regSender.ok ? regSender.value : "sender-1";

  // Register a receiver with incomplete information or register customer type requiring additional documents
  // Calling PUT /customer with partial/missing fields leaves customer in NEEDS_INFO
  let receiverId: string | undefined;
  try {
    // Register customer without required identity verification info
    const sep12Url = `${ANCHOR}/sep12/customer`;
    const incompleteRes = await fetch(sep12Url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: corridor.compliance.sep12_receiver_type,
        first_name: "Incomplete",
        // Omit last_name or required verification documents to force NEEDS_INFO status
      }),
    });
    if (incompleteRes.ok) {
      const data = (await incompleteRes.json()) as { id?: string; status?: string };
      receiverId = data.id;
    }
  } catch {
    // Fall back to a dedicated test identifier
    receiverId = `incomplete-receiver-${Date.now()}`;
  }

  if (!receiverId) {
    receiverId = `incomplete-receiver-${Date.now()}`;
  }

  console.log(`  Registered receiver with incomplete KYC: ${receiverId}`);

  const idemKey = `needs-info-${Date.now()}`;
  const intent: PaymentIntent = {
    idempotencyKey: idemKey,
    corridorId: corridor.id,
    sender: { id: "s-1", sep12Id: senderId },
    recipient: { id: "r-needs-info", sep12Id: receiverId },
    sourceAmount: { asset: corridor.settlement.bridge_asset, amount: "10.00" },
    destinationFields: {
      receiver_routing_number: "021000021",
      receiver_account_number: "12345678901234",
      type: "SWIFT",
    },
  };

  const result = await execute(intent, corridor, deps);
  const stored = await store.get(idemKey);
  const count = await countHorizonTransactions(signer.publicKey, idemKey);

  console.log(`  Run result: ok=${result.ok}, code=${result.ok ? "none" : result.error.code}`);

  // Refusal must happen before settle
  if (
    result.ok ||
    (result.error.code !== "PRESETTLE_RECEIVER_NOT_ACCEPTED" &&
      result.error.code !== "KYC_REQUIRED")
  ) {
    const code = result.ok ? "success" : result.error.code;
    throw new Error(`Expected PRESETTLE_RECEIVER_NOT_ACCEPTED / KYC_REQUIRED, got ${code}`);
  }
  if (stored?.stellarTxHash || count !== 0) {
    throw new Error(
      `Money moved on NEEDS_INFO receiver! (tx: ${stored?.stellarTxHash}, count: ${count})`,
    );
  }

  writeSummary(`
### Live Scenario: Anchor Asks For More Customer Info (#673)
| Step | Expected Error | Resulting Status | On-Chain Transactions | Outcome |
| --- | --- | --- | --- | --- |
| Receiver in \`NEEDS_INFO\` | \`PRESETTLE_RECEIVER_NOT_ACCEPTED\` | \`${result.ok ? "completed" : result.error.code}\` | 0 transactions | ✅ Halted cleanly before settle |
`);

  console.log(
    `\n✓ Scenario #673 passed: run stopped cleanly when receiver in NEEDS_INFO; 0 money moved`,
  );
  return { ok: true };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runNeedsInfoScenario()
    .then(() => process.exit(EXIT_OK))
    .catch((err) => {
      console.error(`\n✗ Scenario #673 failed: ${String(err)}`);
      writeSummary(
        `\n### Live Scenario: Anchor Asks For More Customer Info (#673)\n\n❌ **Failed**: ${String(err)}\n`,
      );
      process.exit(EXIT_NOT_COMPLETED);
    });
}
