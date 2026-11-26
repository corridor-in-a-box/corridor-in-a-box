// Proves a WHOLE CORRIDOR RUN — quote -> comply -> open -> settle -> reconcile
// -> completed — against the local Anchor Platform reference server.
//
//   scripts/reference-anchor.sh up
//   CORRIDOR_SIGNER_SECRET=S... pnpm verify:corridor
//
// This is the counterpart to `pnpm verify:settle`, and the two prove different
// things:
//
//   verify:settle    the settle leg alone, on live testnet, with no anchor.
//   verify:corridor  every leg, against a conformant SEP-31 counterparty.
//
// Unlike `pnpm testnet`, which drives one payment against whatever anchor the
// manifest names and prints a trail to paste into the README, this is a PASS/FAIL
// gate: it exits non-zero unless the run's terminal state is `completed`, so it
// can sit in CI or in front of a release.
//
// It fails loudly and early rather than hanging: the stack is checked with
// `reference-anchor.sh doctor` before a payment is opened, because a run against
// a sick stack ends in RECONCILE_STALLED after 10 identical consecutive polls
// (~20 s with the default stallThreshold=10 and reconcilePollMs=2000).
// SETTLEMENT_TIMEOUT only fires when the anchor's status keeps changing but
// never reaches a terminal state within recovery.timeout_seconds.
//
//   CORRIDOR_SIGNER_SECRET=S...   testnet distribution account seed (required)
//   REFERENCE_ANCHOR_URL=...      local reference server (default localhost:8080)
//   HORIZON_URL=...               default https://horizon-testnet.stellar.org
//   MANIFEST=...                  default corridors/reference.corridor.yaml
//   AMOUNT=...                    default 10.00
//   EXPECT_STATE=...              require a terminal state other than `completed`
//                                 (for fault scenarios; see docs/operations.md)
//   SCENARIO=...                  title of the job-summary block (default:
//                                 "Reference corridor"; fault-scenario.sh sets it)
//   SKIP_DOCTOR=1                 skip the preflight (stack managed elsewhere)
//
// Whatever the terminal state, the run is then checked against the ledger: the
// signer's own transactions on Horizon must show this payment's money leaving
// exactly once if the engine settled it, and not at all if it did not. The
// verdict, the trail and that count go to $GITHUB_STEP_SUMMARY (SUMMARY_FILE
// outside Actions), so a scheduled run leaves its evidence in the job page.

import { fileURLToPath } from "node:url";
import { loadCorridor } from "@corridor/manifest";
import { execute } from "@corridor/engine";
import type { PaymentIntent } from "@corridor/types";
import {
  assertAssetQuotable,
  pinToReferenceAnchor,
  preflightDoctor,
  registerSep12Customer,
  wireCorridorDeps,
  EXIT_MANIFEST,
  EXIT_MISSING_ENV,
  EXIT_REFUSED,
  EXIT_STACK_UNFIT,
  EXIT_NOT_COMPLETED,
} from "../packages/cli/src/wire.js";
import { fetchSignerTransactionsSince } from "./load-test.js";
import {
  appendStepSummary,
  movedAtMostOnce,
  renderScenarioSummary,
  type ScenarioCheck,
} from "./scenario-evidence.js";

const ANCHOR = (process.env.REFERENCE_ANCHOR_URL ?? "http://localhost:8080").replace(
  /\/+$/,
  "",
);
const HORIZON = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const AMOUNT = process.env.AMOUNT ?? "10.00";

function env(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    console.error(`✗ missing required env var ${name}`);
    console.error(`  A testnet distribution account seed. Never a mainnet seed — see`);
    console.error(`  docs/key-management.md.`);
    process.exit(EXIT_MISSING_ENV);
  }
  return v;
}

function resolveManifestPath(): string {
  const p = process.env.MANIFEST ?? "corridors/reference.corridor.yaml";
  return p.startsWith("/") ? p : fileURLToPath(new URL(`../${p}`, import.meta.url));
}

async function main(): Promise<void> {
  const loaded = loadCorridor(resolveManifestPath());
  if (!loaded.ok) {
    console.error(`✗ manifest error: ${loaded.error.message}`);
    process.exit(EXIT_MANIFEST);
  }

  // Same mainnet guard as `pnpm testnet` and `pnpm serve`, with no escape hatch:
  // this runner drives payments at a LOCAL reference server, so a mainnet
  // corridor here is always a mistake rather than a decision.
  if (loaded.value.settlement.network === "public") {
    console.error(
      `✗ corridor "${loaded.value.id}" settles on MAINNET (network=public). This runner ` +
        `verifies against a local reference anchor and will not move real money.`,
    );
    process.exit(EXIT_REFUSED);
  }

  const corridor = pinToReferenceAnchor(loaded.value, ANCHOR);

  const doc = preflightDoctor();
  if (!doc.ok) {
    if (doc.error) {
      console.error(`✗ ${doc.error}`);
    } else {
      console.error(
        `\n✗ the reference anchor is not fit to run a corridor (doctor exit ${doc.status}).`,
      );
      console.error(
        `  Fix the checks above — 'scripts/reference-anchor.sh up' reseeds the observer`,
      );
      console.error(`  cursor, which is the usual culprit.`);
    }
    process.exit(EXIT_STACK_UNFIT);
  }

  const quotable = await assertAssetQuotable(corridor, ANCHOR);
  if (!quotable.ok) {
    console.error(`✗ ${quotable.error}`);
    process.exit(quotable.refused ? EXIT_REFUSED : EXIT_STACK_UNFIT);
  }

  const signerSecret = env("CORRIDOR_SIGNER_SECRET");
  const wired = wireCorridorDeps(corridor, {
    signerSecret,
    horizonUrl: HORIZON,
  });
  const { deps, signer, adapter, store, audit } = wired;

  // SEP-12 identifies both parties to the receiving anchor. The sending side
  // holds the PII and registers; the engine only ever carries the returned ids.
  const register = async (role: "receiver" | "sender", type: string): Promise<string> => {
    console.log(`registering ${role} (SEP-12)…`);
    const reg = await registerSep12Customer(adapter, role, type);
    if (!reg.ok) {
      console.error(
        `✗ SEP-12 ${role} registration failed: ${reg.error.code} — ${reg.error.message}`,
      );
      console.error(
        `  Read the anchor's GET /sep12/customer response for the fields it needs.`,
      );
      process.exit(EXIT_NOT_COMPLETED);
    }
    console.log(`  ${role}: ${reg.value}`);
    return reg.value;
  };

  const senderSep12Id =
    process.env.SENDER_SEP12_ID ??
    (await register("sender", corridor.compliance.sep12_sender_type));
  const recipientSep12Id =
    process.env.RECIPIENT_SEP12_ID ??
    (await register("receiver", corridor.compliance.sep12_receiver_type));

  const intent: PaymentIntent = {
    idempotencyKey: process.env.IDEMPOTENCY_KEY ?? `verify-corridor-${Date.now()}`,
    corridorId: corridor.id,
    sender: {
      id: "sender-1",
      jurisdiction: corridor.compliance.source_jurisdiction,
      sep12Id: senderSep12Id,
    },
    recipient: {
      id: "recipient-1",
      jurisdiction: corridor.compliance.dest_jurisdiction,
      sep12Id: recipientSep12Id,
    },
    sourceAmount: { asset: corridor.settlement.bridge_asset, amount: AMOUNT },
    destinationFields: {
      receiver_routing_number: "021000021",
      receiver_account_number: "12345678901234",
      type: "SWIFT",
    },
  };

  console.log(`\nverifying corridor "${corridor.id}" against ${ANCHOR}`);
  console.log(`  signer:  ${signer.publicKey}`);
  console.log(`  horizon: ${HORIZON}`);
  console.log(
    `  intent:  ${intent.idempotencyKey} (${AMOUNT} ${corridor.settlement.bridge_asset})\n`,
  );

  // Horizon timestamps are whole seconds; start the ledger window a little early.
  const ledgerSince = new Date(Date.now() - 5_000);
  const result = await execute(intent, corridor, deps);

  // The trail comes from the audit sink rather than RunResult, so a FAILED run
  // prints one too — which is the case where it is actually worth reading.
  const trail =
    audit.entries.length > 0
      ? [audit.entries[0].from, ...audit.entries.map((e) => e.to)]
      : ((result.ok ? result.value.trail : []) as readonly string[]);
  const stored = await store.get(intent.idempotencyKey);

  console.log(`\ntrail: ${trail.join(" -> ")}`);
  if (stored?.stellarTxHash) {
    console.log(`stellar tx: ${stored.stellarTxHash}`);
    console.log(
      `explorer:   https://stellar.expert/explorer/testnet/tx/${stored.stellarTxHash}`,
    );
  }

  // A fault scenario (docs/operations.md) expects a run that does NOT complete:
  // the point is the engine's reaction to a misbehaving anchor, so the terminal
  // state is the assertion rather than `completed`.
  const expected = process.env.EXPECT_STATE || undefined;
  const want = expected ?? "completed";
  const terminal = stored?.state ?? (result.ok ? result.value.state : undefined);
  const stateOk = terminal === want;

  if (!result.ok) {
    console.error(`\n✗ ${result.error.code} — ${result.error.message}`);
    console.error(`  terminal state: ${terminal ?? "unknown"}`);
  } else if (stored?.lastError) {
    console.log(`  last error: ${stored.lastError}`);
  }
  if (stateOk && expected !== undefined) {
    console.log(`\n✓ terminal state is "${expected}", as the fault scenario expects`);
  } else if (!stateOk && expected !== undefined) {
    console.error(`\n✗ expected terminal state "${expected}", got "${terminal ?? "unknown"}"`);
  } else if (!stateOk && result.ok) {
    console.error(`\n✗ terminal state is "${terminal ?? "unknown"}", not "completed"`);
  }

  // The ledger, not the engine, says how often the money left: a payment that
  // settled must appear once among the signer's own transactions, and one that
  // never settled must not appear at all.
  let moved: ScenarioCheck;
  try {
    const txs = await fetchSignerTransactionsSince(HORIZON, signer.publicKey, ledgerSince);
    moved = movedAtMostOnce(
      txs,
      { memo: stored?.memo, stellarTxHash: stored?.stellarTxHash },
      signer.publicKey,
    );
  } catch (e) {
    moved = {
      label: "money moved at most once on chain",
      ok: false,
      detail: `could not read the signer's transactions from Horizon: ${String(e)}`,
    };
  }
  console.log(`  ${moved.ok ? "✓" : "✗"} ${moved.label} — ${moved.detail}`);

  const checks: ScenarioCheck[] = [
    {
      label: `terminal state is \`${want}\``,
      ok: stateOk,
      detail: `state=${terminal ?? "unknown"}`,
    },
    moved,
  ];
  appendStepSummary(
    renderScenarioSummary(
      process.env.SCENARIO || "Reference corridor",
      [
        { label: "Corridor", value: `\`${corridor.id}\`` },
        {
          label: "Intent",
          value: `\`${intent.idempotencyKey}\` (${AMOUNT} ${corridor.settlement.bridge_asset})`,
        },
        { label: "Expected state", value: `\`${want}\`` },
        { label: "Terminal state", value: `\`${terminal ?? "unknown"}\`` },
        {
          label: "Error",
          value: result.ok
            ? (stored?.lastError ?? "none")
            : `\`${result.error.code}\` — ${result.error.message}`,
        },
        { label: "Trail", value: `\`${trail.join(" -> ") || "none"}\`` },
        {
          label: "Settlement",
          value: stored?.stellarTxHash
            ? `[\`${stored.stellarTxHash}\`](https://stellar.expert/explorer/testnet/tx/${stored.stellarTxHash})`
            : "none",
        },
      ],
      checks,
    ),
  );

  if (!stateOk) process.exit(EXIT_NOT_COMPLETED);
  if (!moved.ok) {
    console.error(`\n✗ the ledger does not show this payment moving at most once`);
    process.exit(EXIT_NOT_COMPLETED);
  }
  if (expected !== undefined) return;

  console.log(`\n✓ corridor completed end to end against the reference anchor`);
  console.log(`  ${audit.entries.length} transitions recorded`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
