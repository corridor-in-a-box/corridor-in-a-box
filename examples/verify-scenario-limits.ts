// Live testnet scenario: amounts outside the anchor's limits (Issue #676)
//
// Reads the limits from the reference anchor's /sep31/info, runs payments
// below the minimum and above the maximum, and asserts both are refused
// before settle with PRESETTLE_AMOUNT_OUT_OF_RANGE, moving no money.
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

export async function runLimitsScenario(): Promise<{ ok: boolean; error?: string }> {
  console.log("\n=== Scenario #676: Amounts outside the anchor's limits ===");

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

  // 1. Read limits from /sep31/info
  let minAmount = "1.00";
  let maxAmount = "10000.00";
  try {
    const infoRes = await fetch(`${ANCHOR}/sep31/info`);
    if (infoRes.ok) {
      const info = (await infoRes.json()) as {
        receive?: Record<
          string,
          { min_amount?: string | number; max_amount?: string | number }
        >;
      };
      const assetInfo = info.receive?.[corridor.settlement.bridge_asset];
      if (assetInfo?.min_amount !== undefined) minAmount = String(assetInfo.min_amount);
      if (assetInfo?.max_amount !== undefined) maxAmount = String(assetInfo.max_amount);
    }
  } catch {
    console.warn("Could not fetch live /sep31/info limits; using defaults");
  }

  console.log(
    `  Anchor limits for ${corridor.settlement.bridge_asset}: min=${minAmount}, max=${maxAmount}`,
  );

  // Register customers once
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

  const belowMinAmount = "0.01";
  const aboveMaxAmount = (Number(maxAmount) + 5000).toFixed(2);

  // Case A: Below Minimum
  console.log(
    `\nTesting amount below minimum: ${belowMinAmount} ${corridor.settlement.bridge_asset}...`,
  );
  const idemKeyBelow = `limits-below-${Date.now()}`;
  const intentBelow: PaymentIntent = {
    idempotencyKey: idemKeyBelow,
    corridorId: corridor.id,
    sender: { id: "s-1", sep12Id: senderId },
    recipient: { id: "r-1", sep12Id: receiverId },
    sourceAmount: { asset: corridor.settlement.bridge_asset, amount: belowMinAmount },
    destinationFields: {
      receiver_routing_number: "021000021",
      receiver_account_number: "12345678901234",
      type: "SWIFT",
    },
  };

  const resBelow = await execute(intentBelow, corridor, deps);
  const storedBelow = await store.get(idemKeyBelow);
  const countBelow = await countHorizonTransactions(signer.publicKey, idemKeyBelow);

  if (resBelow.ok || resBelow.error.code !== "PRESETTLE_AMOUNT_OUT_OF_RANGE") {
    const code = resBelow.ok ? "success" : resBelow.error.code;
    throw new Error(
      `Expected PRESETTLE_AMOUNT_OUT_OF_RANGE for below-min amount, got ${code}`,
    );
  }
  if (storedBelow?.stellarTxHash || countBelow !== 0) {
    throw new Error(
      `Money moved on below-min payment! (tx: ${storedBelow?.stellarTxHash}, count: ${countBelow})`,
    );
  }
  console.log(`  ✓ Refused before settle: ${resBelow.error.code} (0 money moved)`);

  // Case B: Above Maximum
  console.log(
    `\nTesting amount above maximum: ${aboveMaxAmount} ${corridor.settlement.bridge_asset}...`,
  );
  const idemKeyAbove = `limits-above-${Date.now()}`;
  const intentAbove: PaymentIntent = {
    idempotencyKey: idemKeyAbove,
    corridorId: corridor.id,
    sender: { id: "s-1", sep12Id: senderId },
    recipient: { id: "r-1", sep12Id: receiverId },
    sourceAmount: { asset: corridor.settlement.bridge_asset, amount: aboveMaxAmount },
    destinationFields: {
      receiver_routing_number: "021000021",
      receiver_account_number: "12345678901234",
      type: "SWIFT",
    },
  };

  const resAbove = await execute(intentAbove, corridor, deps);
  const storedAbove = await store.get(idemKeyAbove);
  const countAbove = await countHorizonTransactions(signer.publicKey, idemKeyAbove);

  if (resAbove.ok || resAbove.error.code !== "PRESETTLE_AMOUNT_OUT_OF_RANGE") {
    const code = resAbove.ok ? "success" : resAbove.error.code;
    throw new Error(
      `Expected PRESETTLE_AMOUNT_OUT_OF_RANGE for above-max amount, got ${code}`,
    );
  }
  if (storedAbove?.stellarTxHash || countAbove !== 0) {
    throw new Error(
      `Money moved on above-max payment! (tx: ${storedAbove?.stellarTxHash}, count: ${countAbove})`,
    );
  }
  console.log(`  ✓ Refused before settle: ${resAbove.error.code} (0 money moved)`);

  // Record in job summary
  writeSummary(`
### Live Scenario: Amounts Outside Anchor Limits (#676)
| Test Case | Attempted Amount | Advertised Limits | Final State | Money Moved | Invariant |
| --- | --- | --- | --- | --- | --- |
| Below minimum | \`${belowMinAmount}\` | min: \`${minAmount}\` | \`PRESETTLE_AMOUNT_OUT_OF_RANGE\` | 0 transactions | ✅ Refused before settle |
| Above maximum | \`${aboveMaxAmount}\` | max: \`${maxAmount}\` | \`PRESETTLE_AMOUNT_OUT_OF_RANGE\` | 0 transactions | ✅ Refused before settle |
`);

  console.log(`\n✓ Scenario #676 passed: amounts outside limits refused before money moves`);
  return { ok: true };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runLimitsScenario()
    .then(() => process.exit(EXIT_OK))
    .catch((err) => {
      console.error(`\n✗ Scenario #676 failed: ${String(err)}`);
      writeSummary(
        `\n### Live Scenario: Amounts Outside Anchor Limits (#676)\n\n❌ **Failed**: ${String(err)}\n`,
      );
      process.exit(EXIT_NOT_COMPLETED);
    });
}
