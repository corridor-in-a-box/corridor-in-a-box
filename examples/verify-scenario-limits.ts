// Live testnet scenario: amounts outside the anchor's limits (#676).
//
//   SEND_MIN_AMOUNT=5 scripts/reference-anchor.sh up
//   CORRIDOR_SIGNER_SECRET=S... pnpm verify:scenario-limits
//
// Reads the bridge asset's limits from the reference anchor's own
// GET /sep31/info, then runs two whole corridor payments against it: one just
// below the minimum and one just above the maximum. Both must be refused, for
// their limits, before any money moves.
//
// The image advertises a minimum of 0, and nothing below 0 is a payment, so the
// stack has to be started with SEND_MIN_AMOUNT (see reference-anchor.sh). Keep
// it above 2: the reference server charges a fixed 1.00 fee in its quotes, and
// a sell amount of 1.00 or less fails there ("Buy amount must be greater than
// zero") before the limit is ever consulted — refused, but not for its limits,
// which is exactly the false pass the limit check below rules out.
//
// Each payment is asserted, not printed: the run was refused, the refusal names
// the anchor's (or the engine's) limit, the terminal state is `failed`, the
// settlement submitter was never called, no settlement is recorded, the ledger
// shows no transaction from the signer for it, and the signer's bridge-asset
// balance is unchanged. Results go to $GITHUB_STEP_SUMMARY (SUMMARY_FILE outside
// Actions). No payout-watch and no fault is needed: nothing reaches the payout.
//
//   CORRIDOR_SIGNER_SECRET=S...   testnet signer seed (required)
//   REFERENCE_ANCHOR_URL=...      local reference server (default localhost:8080)
//   HORIZON_URL=...               default https://horizon-testnet.stellar.org
//   MANIFEST=...                  default corridors/reference.corridor.yaml
//   SKIP_DOCTOR=1                 skip the preflight (stack managed elsewhere)

import { fileURLToPath } from "node:url";
import { loadCorridor } from "@corridor/manifest";
import { execute, type EngineDeps } from "@corridor/engine";
import { receiveLimitsFrom, type ReceiveAssetLimits } from "@corridor/probe";
import { AccountInspector } from "@corridor/stellar";
import { fail, ok, type PaymentIntent } from "@corridor/types";
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
  amountsOutsideLimits,
  appendStepSummary,
  movedAtMostOnce,
  refusalNamesLimit,
  renderScenarioSummary,
  type ScenarioCheck,
} from "./scenario-evidence.js";

const ANCHOR = (process.env.REFERENCE_ANCHOR_URL ?? "http://localhost:8080").replace(
  /\/+$/,
  "",
);
const HORIZON = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const TITLE = "Amounts outside the anchor's limits (#676)";

function env(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    console.error(`✗ missing required env var ${name}`);
    console.error(
      `  A testnet signer seed. Never a mainnet seed — see docs/key-management.md.`,
    );
    process.exit(EXIT_MISSING_ENV);
  }
  return v;
}

function resolveManifestPath(): string {
  const p = process.env.MANIFEST ?? "corridors/reference.corridor.yaml";
  return p.startsWith("/") ? p : fileURLToPath(new URL(`../${p}`, import.meta.url));
}

/** The signer's line for the corridor's bridge asset, or a reason it is absent. */
async function bridgeBalance(
  inspector: AccountInspector,
  account: string,
  code: string,
  issuer: string | undefined,
): Promise<string> {
  const facts = await inspector.account(account);
  if (!facts.ok) return `unreadable (${facts.error.code})`;
  if (!facts.value) return "account missing";
  const line = facts.value.balances.find(
    (b) => b.asset_code === code && b.asset_issuer === issuer,
  );
  return line ? line.balance : `no ${code} trustline`;
}

async function main(): Promise<void> {
  const loaded = loadCorridor(resolveManifestPath());
  if (!loaded.ok) {
    console.error(`✗ manifest error: ${loaded.error.message}`);
    process.exit(EXIT_MANIFEST);
  }
  // Same mainnet guard as `pnpm verify:corridor`, with no escape hatch.
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
    console.error(
      doc.error
        ? `✗ ${doc.error}`
        : `\n✗ the reference anchor is not fit to run a corridor (doctor exit ${doc.status}).`,
    );
    process.exit(EXIT_STACK_UNFIT);
  }

  const quotable = await assertAssetQuotable(corridor, ANCHOR);
  if (!quotable.ok) {
    console.error(`✗ ${quotable.error}`);
    process.exit(quotable.refused ? EXIT_REFUSED : EXIT_STACK_UNFIT);
  }

  const signerSecret = env("CORRIDOR_SIGNER_SECRET");
  const wired = wireCorridorDeps(corridor, { signerSecret, horizonUrl: HORIZON });
  const { signer, adapter, store, audit } = wired;
  const bridge = corridor.settlement.bridge_asset;
  const inspector = new AccountInspector({ horizonUrl: HORIZON });

  // The limits come from the anchor itself, not the manifest. Read raw and
  // parsed with @corridor/probe's reader: SEP-31 states them as JSON numbers
  // (the reference anchor sends `"min_amount": 5`), which Sep31Adapter.getInfo
  // deliberately drops rather than risk a lossy float.
  let limits: ReceiveAssetLimits | undefined;
  try {
    const res = await fetch(`${ANCHOR}/sep31/info`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { receive?: Record<string, unknown> };
    limits = receiveLimitsFrom(body.receive ?? {}).find((l) => l.code === bridge);
  } catch (e) {
    console.error(`✗ could not read ${ANCHOR}/sep31/info: ${String(e)}`);
    process.exit(EXIT_STACK_UNFIT);
  }
  const { below, above, problems } = amountsOutsideLimits(
    limits?.minAmount,
    limits?.maxAmount,
  );
  console.log(
    `anchor limits for ${bridge}: min=${limits?.minAmount ?? "none"} max=${limits?.maxAmount ?? "none"}`,
  );
  if (problems.length > 0 || below === undefined || above === undefined) {
    const why = problems.join("; ");
    console.error(`✗ cannot run the limits scenario: ${why}`);
    console.error(
      `  Start the stack with SEND_MIN_AMOUNT=<whole number above 2> (see docs/operations.md).`,
    );
    appendStepSummary(
      renderScenarioSummary(
        TITLE,
        [
          { label: "Anchor", value: `\`${ANCHOR}\`` },
          {
            label: "Advertised limits",
            value: `min=${limits?.minAmount ?? "none"} max=${limits?.maxAmount ?? "none"}`,
          },
        ],
        [{ label: "the anchor advertises limits to test against", ok: false, detail: why }],
      ),
    );
    process.exit(EXIT_STACK_UNFIT);
  }

  // Real SEP-12 ids, so a refusal cannot come from an unknown customer.
  const register = async (role: "receiver" | "sender", type: string): Promise<string> => {
    const reg = await registerSep12Customer(adapter, role, type);
    if (!reg.ok) {
      console.error(
        `✗ SEP-12 ${role} registration failed: ${reg.error.code} — ${reg.error.message}`,
      );
      process.exit(EXIT_NOT_COMPLETED);
    }
    return reg.value;
  };
  const senderSep12Id = await register("sender", corridor.compliance.sep12_sender_type);
  const recipientSep12Id = await register("receiver", corridor.compliance.sep12_receiver_type);

  // The only port that moves money, closed: neither payment may settle, so a
  // call is counted and refused rather than passed to Stellar. If the anchor
  // ever accepted an out-of-range amount, the run fails here with nothing sent.
  let submitCalls = 0;
  const submitter: EngineDeps["submitter"] = {
    findExisting: (req) =>
      wired.submitter.findExisting?.(req) ?? Promise.resolve(ok(undefined)),
    submit: async () => {
      submitCalls += 1;
      return fail(
        "SETTLEMENT_FAILED",
        "the limits scenario never settles: an out-of-range amount reached the settle leg",
        { retryable: false },
      );
    },
    refund: (req) => wired.submitter.refund(req),
  };

  let allPassed = true;
  const cases = [
    { name: "below the minimum", amount: below, limit: `min ${limits?.minAmount}` },
    { name: "above the maximum", amount: above, limit: `max ${limits?.maxAmount}` },
  ];
  // The engine caps a corridor with no fresh canary proof at 10 by default,
  // which would refuse the above-maximum amount before the anchor ever saw it.
  // Lifted to the amount under test, so the anchor's own limit is what is
  // exercised; the closed submitter above still keeps any money from moving.
  const deps: EngineDeps = { ...wired.deps, submitter, unprovenMaxAmount: above };
  for (const c of cases) {
    const intent: PaymentIntent = {
      idempotencyKey: `verify-limits-${c.name.split(" ")[0]}-${Date.now()}`,
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
      sourceAmount: { asset: bridge, amount: c.amount },
      destinationFields: {
        receiver_routing_number: "021000021",
        receiver_account_number: "12345678901234",
        type: "SWIFT",
      },
    };

    console.log(`\n${c.name}: ${c.amount} ${bridge} (anchor ${c.limit})`);
    const submitsBefore = submitCalls;
    const auditBefore = audit.entries.length;
    const balanceBefore = await bridgeBalance(
      inspector,
      signer.publicKey,
      bridge,
      corridor.settlement.asset_issuer,
    );
    const ledgerSince = new Date(Date.now() - 5_000);

    const result = await execute(intent, corridor, deps);

    const stored = await store.get(intent.idempotencyKey);
    const entries = audit.entries.slice(auditBefore);
    const trail = entries.length > 0 ? [entries[0].from, ...entries.map((e) => e.to)] : [];
    const balanceAfter = await bridgeBalance(
      inspector,
      signer.publicKey,
      bridge,
      corridor.settlement.asset_issuer,
    );
    let ledger: ScenarioCheck;
    try {
      const txs = await fetchSignerTransactionsSince(HORIZON, signer.publicKey, ledgerSince);
      ledger = movedAtMostOnce(
        txs,
        { memo: stored?.memo, stellarTxHash: stored?.stellarTxHash },
        signer.publicKey,
      );
    } catch (e) {
      ledger = {
        label: "no money moved on chain",
        ok: false,
        detail: `could not read the signer's transactions from Horizon: ${String(e)}`,
      };
    }
    const submits = submitCalls - submitsBefore;

    const checks: ScenarioCheck[] = [
      {
        label: "the run was refused",
        ok: !result.ok,
        detail: result.ok
          ? `it ran to ${result.value.state}`
          : `${result.error.code}: ${result.error.message}`,
      },
      {
        label: "the refusal names the limit",
        ok: !result.ok && refusalNamesLimit(result.error.message),
        detail: result.ok ? "no refusal" : result.error.message,
      },
      {
        label: "terminal state is `failed`",
        ok: stored?.state === "failed",
        detail: `state=${stored?.state ?? "unknown"}`,
      },
      {
        label: "no settlement was submitted",
        ok: submits === 0 && !stored?.stellarTxHash,
        detail: `submitter.submit calls=${submits}, stellarTxHash=${stored?.stellarTxHash ?? "none"}`,
      },
      ledger,
      {
        label: "the signer's balance is unchanged",
        ok: balanceBefore === balanceAfter,
        detail: `${balanceBefore} -> ${balanceAfter} ${bridge}`,
      },
    ];
    const passed = checks.every((k) => k.ok);
    allPassed &&= passed;

    console.log(`trail: ${trail.join(" -> ") || "none"}`);
    for (const k of checks) console.log(`  ${k.ok ? "✓" : "✗"} ${k.label} — ${k.detail}`);

    appendStepSummary(
      renderScenarioSummary(
        `${TITLE}: ${c.name}`,
        [
          { label: "Corridor", value: `\`${corridor.id}\`` },
          { label: "Anchor", value: `\`${ANCHOR}\`` },
          { label: "Intent", value: `\`${intent.idempotencyKey}\`` },
          { label: "Amount", value: `${c.amount} ${bridge} (anchor ${c.limit})` },
          {
            label: "Refusal",
            value: result.ok ? "none" : `\`${result.error.code}\` — ${result.error.message}`,
          },
          { label: "Terminal state", value: `\`${stored?.state ?? "unknown"}\`` },
          { label: "Trail", value: `\`${trail.join(" -> ") || "none"}\`` },
          { label: `${bridge} balance`, value: `${balanceBefore} -> ${balanceAfter}` },
        ],
        checks,
      ),
    );
  }

  if (!allPassed) {
    console.error(
      `\n✗ an amount outside the anchor's limits was not refused the way it must be`,
    );
    process.exit(EXIT_NOT_COMPLETED);
  }
  console.log(
    `\n✓ both amounts outside the anchor's limits were refused before any money moved`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
