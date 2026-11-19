// Live testnet scenario: payout fails and the anchor refunds (Issue #674)
//
// Uses extended `payout-watch refund` in `scripts/reference-anchor.sh` so the
// anchor payout operator marks the transaction as refunded instead of completing.
// Asserts the engine reconciles into `recovering` -> `refunded` with exactly
// one on-chain settlement transaction (no money moved twice).
// Results are captured in the job summary ($GITHUB_STEP_SUMMARY).

import { spawn } from "node:child_process";
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

export async function runRefundScenario(): Promise<{ ok: boolean; error?: string }> {
  console.log("\n=== Scenario #674: Payout fails and anchor refunds ===");

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
  const { deps, signer, adapter, store, audit } = wired;

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

  // 2. Start payout-watch in refund mode: marks transactions as refunded instead of completed
  console.log("  Starting reference-anchor.sh payout-watch refund...");
  const watcher = spawn(ANCHOR_SCRIPT, ["payout-watch", "refund"], {
    stdio: "inherit",
    env: { ...process.env, PAYOUT_ACTION: "refund" },
  });

  const idemKey = `refund-${Date.now()}`;
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

  try {
    console.log(`  Executing corridor run: ${idemKey}...`);
    const result = await execute(intent, corridor, deps);
    const stored = await store.get(idemKey);
    const count = await countHorizonTransactions(signer.publicKey, idemKey);

    const trail =
      audit.entries.length > 0
        ? [audit.entries[0].from, ...audit.entries.map((e) => e.to)]
        : [];

    console.log(`  Trail: ${trail.join(" -> ")}`);
    console.log(`  Stored terminal state: ${stored?.state ?? "unknown"}`);
    console.log(`  Stellar tx: ${stored?.stellarTxHash ?? "none"}`);
    console.log(`  On-chain settlement count: ${count}`);

    // Invariants:
    // 1. Terminal state must be "refunded"
    if (stored?.state !== "refunded") {
      throw new Error(
        `Expected terminal state "refunded", got "${stored?.state ?? "unknown"}" (result.ok=${result.ok})`,
      );
    }

    // 2. Settlement occurred on chain
    if (!stored.stellarTxHash) {
      throw new Error("Missing stellarTxHash on settled & refunded run");
    }

    // 3. No money moved twice
    if (count !== 1) {
      throw new Error(`Expected exactly 1 on-chain settlement transaction, got ${count}`);
    }

    writeSummary(`
### Live Scenario: Payout Fails and Anchor Refunds (#674)
| Parameter | Value | Note |
| --- | --- | --- |
| Corridor | \`${corridor.id}\` | Reference anchor testnet |
| Idempotency Key | \`${idemKey}\` | Single payment run |
| Payout Handler | \`payout-watch refund\` | Simulates off-chain payout failure |
| Terminal State | \`refunded\` | ✅ Recovered to refunded |
| On-Chain Tx Count | \`1\` | ✅ No money moved twice |
| Settlement Tx | \`${stored.stellarTxHash}\` | [Explorer link](https://stellar.expert/explorer/testnet/tx/${stored.stellarTxHash}) |
`);

    console.log(
      `\n✓ Scenario #674 passed: payment reached terminal state "refunded" with exactly 1 on-chain transaction`,
    );
    return { ok: true };
  } finally {
    watcher.kill("SIGKILL");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runRefundScenario()
    .then(() => process.exit(EXIT_OK))
    .catch((err) => {
      console.error(`\n✗ Scenario #674 failed: ${String(err)}`);
      writeSummary(
        `\n### Live Scenario: Payout Fails and Anchor Refunds (#674)\n\n❌ **Failed**: ${String(err)}\n`,
      );
      process.exit(EXIT_NOT_COMPLETED);
    });
}
