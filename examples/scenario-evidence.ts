// Evidence shared by the live scenarios against the reference anchor
// (docs/operations.md, "Live failure scenarios"): how many times one payment's
// money actually left the signer, the amounts just outside an anchor's limits,
// and the job-summary block every run leaves behind.
//
// Everything here except `appendStepSummary` is pure, so the accounting is
// unit-tested without a network or a container (tests/live-scenarios.test.ts).
// The ledger read itself is `fetchSignerTransactionsSince` in ./load-test.ts.

import { appendFileSync } from "node:fs";
import { compareAmounts, fromScaled, toScaled } from "@corridor/types";
import type { OnChainTransaction } from "./load-test.js";

/** One payment, as the engine recorded it. */
export interface PaymentRef {
  /** The SEP-31 memo the anchor issued at open; absent if it never opened. */
  readonly memo?: string;
  /** The settlement the engine submitted; absent if it never settled. */
  readonly stellarTxHash?: string;
}

/**
 * Successful transactions the signer submitted for this payment: the recorded
 * hash, or anything else carrying the payment's memo. Transactions someone
 * else submitted (a top-up, a refund from the anchor) do not count — they are
 * not the sender's money leaving.
 */
export function settlementsOnChain(
  txs: readonly OnChainTransaction[],
  ref: PaymentRef,
  signer: string,
): readonly string[] {
  const hashes = new Set<string>();
  for (const tx of txs) {
    if (!tx.successful) continue;
    if (tx.sourceAccount !== undefined && tx.sourceAccount !== signer) continue;
    const byHash = ref.stellarTxHash !== undefined && tx.hash === ref.stellarTxHash;
    const byMemo = ref.memo !== undefined && ref.memo !== "" && tx.memo === ref.memo;
    if (byHash || byMemo) hashes.add(tx.hash);
  }
  return [...hashes];
}

export interface ScenarioCheck {
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * "No money moved twice", read from the ledger rather than the engine: a
 * payment the engine settled must appear exactly once, and one it never
 * settled must not appear at all.
 */
export function movedAtMostOnce(
  txs: readonly OnChainTransaction[],
  ref: PaymentRef,
  signer: string,
): ScenarioCheck {
  const found = settlementsOnChain(txs, ref, signer);
  const expected = ref.stellarTxHash ? 1 : 0;
  const label = ref.stellarTxHash
    ? "money moved exactly once on chain"
    : "no money moved on chain";
  if (found.length !== expected) {
    return {
      label,
      ok: false,
      detail: `${found.length} settlement(s) from the signer for this payment, expected ${expected}${
        found.length > 0 ? ` (${found.join(", ")})` : ""
      }`,
    };
  }
  if (ref.stellarTxHash && !found.includes(ref.stellarTxHash)) {
    return {
      label,
      ok: false,
      detail: `the ledger shows ${found[0]}, not the recorded ${ref.stellarTxHash}`,
    };
  }
  return {
    label,
    ok: true,
    detail: ref.stellarTxHash
      ? `1 settlement from the signer (${ref.stellarTxHash})`
      : "0 settlements from the signer",
  };
}

const ONE = 10_000_000n; // one whole unit at stroop scale

/**
 * Amounts just outside an anchor's advertised SEP-31 limits: one whole unit
 * below the minimum (half the minimum when that is 1 or less) and one whole
 * unit above the maximum. A missing or zero minimum has nothing below it that
 * is still a payment, so it is reported as a problem rather than guessed at.
 */
export function amountsOutsideLimits(
  min: string | undefined,
  max: string | undefined,
): { readonly below?: string; readonly above?: string; readonly problems: readonly string[] } {
  const problems: string[] = [];
  let below: string | undefined;
  let above: string | undefined;

  if (min === undefined || min === "") {
    problems.push("the anchor advertises no minimum");
  } else {
    const m = toScaled(min);
    if (!m.ok) problems.push(`the anchor's minimum is not an amount: "${min}"`);
    else if (m.value <= 0n)
      problems.push(`the anchor's minimum is ${min}, so no payment is below it`);
    else below = fromScaled(m.value > ONE ? m.value - ONE : m.value / 2n);
  }

  if (max === undefined || max === "") {
    problems.push("the anchor advertises no maximum");
  } else {
    const m = toScaled(max);
    if (!m.ok) problems.push(`the anchor's maximum is not an amount: "${max}"`);
    else if (m.value <= 0n) problems.push(`the anchor's maximum is ${max}`);
    else above = fromScaled(m.value + ONE);
  }

  if (below !== undefined && above !== undefined) {
    const cmp = compareAmounts(min as string, max as string);
    if (cmp.ok && cmp.value > 0)
      problems.push(`the anchor's minimum ${min} exceeds its maximum ${max}`);
  }
  return { below, above, problems };
}

/**
 * Whether a refusal names the anchor's limits — so "refused" cannot be passed
 * by an unrelated failure (a quote outage, a bad customer id). Matches the
 * Anchor Platform's `sell_amount less than min limit` / `exceeds max limit` and
 * the engine's own `amount X is below minimum Y` / `above maximum Y`.
 */
export function refusalNamesLimit(message: string): boolean {
  return /\b(min|max)(imum)? limit\b|\bbelow minimum\b|\babove maximum\b|out of range/i.test(
    message,
  );
}

export interface SummaryRow {
  readonly label: string;
  readonly value: string;
}

/** One scenario's block for `$GITHUB_STEP_SUMMARY`. */
export function renderScenarioSummary(
  title: string,
  rows: readonly SummaryRow[],
  checks: readonly ScenarioCheck[],
): string {
  const passed = checks.length > 0 && checks.every((c) => c.ok);
  const cell = (s: string) =>
    s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
  return [
    `### ${title}`,
    "",
    `**${passed ? "PASS" : "FAIL"}**`,
    "",
    "| Field | Value |",
    "| --- | --- |",
    ...rows.map((r) => `| ${cell(r.label)} | ${cell(r.value)} |`),
    "",
    ...checks.map((c) => `- ${c.ok ? "✅" : "❌"} ${c.label} — ${cell(c.detail)}`),
    "",
  ].join("\n");
}

/**
 * Append to the Actions job summary (`GITHUB_STEP_SUMMARY`, or `SUMMARY_FILE`
 * outside Actions); print it when neither is set. Never throws: losing the
 * summary must not change a scenario's verdict.
 */
export function appendStepSummary(markdown: string): void {
  const path = process.env.GITHUB_STEP_SUMMARY ?? process.env.SUMMARY_FILE;
  if (!path) {
    console.log(`\n${markdown}`);
    return;
  }
  try {
    appendFileSync(path, `${markdown}\n`, "utf8");
    console.log(`\n(summary written to ${path})`);
  } catch (e) {
    console.warn(`could not write the job summary to ${path}: ${String(e)}`);
    console.log(`\n${markdown}`);
  }
}
