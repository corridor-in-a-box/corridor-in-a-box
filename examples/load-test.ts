// Executes a concurrent load test (100 payments by default) against the
// reference anchor on Stellar Testnet, measuring latency, failure rate, and
// asserting zero duplicate settlements.
//
//   scripts/reference-anchor.sh up
//   CORRIDOR_SIGNER_SECRET=S... pnpm load-test
//
// Environment variables:
//   CORRIDOR_SIGNER_SECRET=S...   testnet distribution account seed (required)
//   REFERENCE_ANCHOR_URL=...      local reference server (default localhost:8080)
//   HORIZON_URL=...               default https://horizon-testnet.stellar.org
//   MANIFEST=...                  default corridors/reference.corridor.yaml
//   CONCURRENCY=...               default 100
//   AMOUNT=...                    default 0.10
//   GITHUB_STEP_SUMMARY=...       GitHub Actions step summary file path
//   SUMMARY_FILE=...              alternative markdown summary output path
//   SKIP_DOCTOR=1                 skip the preflight check

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadCorridor, type Corridor } from "@corridor/manifest";
import { execute, type EngineDeps } from "@corridor/engine";
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

export interface PaymentAttemptResult {
  readonly index: number;
  readonly idempotencyKey: string;
  readonly ok: boolean;
  readonly state: string;
  readonly latencyMs: number;
  readonly stellarTxHash?: string;
  readonly error?: string;
}

export interface LoadTestMetrics {
  readonly total: number;
  readonly successful: number;
  readonly failed: number;
  readonly duplicateSettlements: number;
  readonly successRatePercent: number;
  readonly totalDurationMs: number;
  readonly latency: {
    readonly min: number;
    readonly max: number;
    readonly avg: number;
    readonly p50: number;
    readonly p90: number;
    readonly p95: number;
    readonly p99: number;
  };
  readonly errorCounts: Record<string, number>;
  readonly uniqueTxHashes: readonly string[];
}

export function detectDuplicateSettlements(results: readonly PaymentAttemptResult[]): {
  readonly hasDuplicates: boolean;
  readonly duplicateHashes: readonly string[];
  readonly totalSettled: number;
  readonly uniqueSettled: number;
} {
  const settledHashes = results
    .filter((r) => r.ok && r.stellarTxHash)
    .map((r) => r.stellarTxHash as string);

  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const hash of settledHashes) {
    if (seen.has(hash)) {
      duplicates.add(hash);
    } else {
      seen.add(hash);
    }
  }

  return {
    hasDuplicates: duplicates.size > 0,
    duplicateHashes: Array.from(duplicates),
    totalSettled: settledHashes.length,
    uniqueSettled: seen.size,
  };
}

export function computePercentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const clampedRank = Math.max(0, Math.min(rank, sorted.length - 1));
  return sorted[clampedRank];
}

export function computeMetrics(
  results: readonly PaymentAttemptResult[],
  totalDurationMs: number,
): LoadTestMetrics {
  const total = results.length;
  const successful = results.filter((r) => r.ok && r.state === "completed").length;
  const failed = total - successful;
  const successRatePercent = total > 0 ? (successful / total) * 100 : 0;

  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const min = latencies.length > 0 ? latencies[0] : 0;
  const max = latencies.length > 0 ? latencies[latencies.length - 1] : 0;
  const sum = latencies.reduce((acc, curr) => acc + curr, 0);
  const avg = latencies.length > 0 ? Math.round(sum / latencies.length) : 0;

  const p50 = computePercentile(latencies, 50);
  const p90 = computePercentile(latencies, 90);
  const p95 = computePercentile(latencies, 95);
  const p99 = computePercentile(latencies, 99);

  const errorCounts: Record<string, number> = {};
  for (const r of results) {
    if (!r.ok || r.state !== "completed") {
      const err = r.error ?? r.state ?? "unknown_error";
      errorCounts[err] = (errorCounts[err] ?? 0) + 1;
    }
  }

  const dupCheck = detectDuplicateSettlements(results);
  const duplicateSettlements = dupCheck.totalSettled - dupCheck.uniqueSettled;
  const uniqueTxHashes = Array.from(
    new Set(
      results.filter((r) => r.ok && r.stellarTxHash).map((r) => r.stellarTxHash as string),
    ),
  );

  return {
    total,
    successful,
    failed,
    duplicateSettlements,
    successRatePercent: Math.round(successRatePercent * 10) / 10,
    totalDurationMs,
    latency: { min, max, avg, p50, p90, p95, p99 },
    errorCounts,
    uniqueTxHashes,
  };
}

export function formatMarkdownReport(
  metrics: LoadTestMetrics,
  context?: {
    corridorId?: string;
    concurrency?: number;
    amount?: string;
    anchorUrl?: string;
  },
): string {
  const lines: string[] = [];

  lines.push("## 🚀 Corridor Load Test Summary");
  lines.push("");
  if (context) {
    lines.push(`- **Corridor**: \`${context.corridorId ?? "reference"}\``);
    lines.push(`- **Target Anchor**: \`${context.anchorUrl ?? "reference anchor"}\``);
    lines.push(`- **Concurrent Payments**: \`${context.concurrency ?? metrics.total}\``);
    lines.push(`- **Amount per payment**: \`${context.amount ?? "0.10"} USDC\``);
    lines.push(
      `- **Total Wall-Clock Time**: \`${(metrics.totalDurationMs / 1000).toFixed(2)}s\``,
    );
    lines.push("");
  }

  lines.push("### Execution Overview");
  lines.push("");
  lines.push("| Metric | Value | Status |");
  lines.push("| :--- | :--- | :--- |");
  lines.push(`| Total Payments | ${metrics.total} | ℹ️ |`);
  lines.push(
    `| Successful | ${metrics.successful} | ${metrics.successful === metrics.total ? "✅" : "⚠️"} |`,
  );
  lines.push(`| Failed | ${metrics.failed} | ${metrics.failed === 0 ? "✅" : "❌"} |`);
  lines.push(
    `| Duplicate Settlements | ${metrics.duplicateSettlements} | ${metrics.duplicateSettlements === 0 ? "✅ None (No double-spend)" : "❌ DUPLICATES DETECTED"} |`,
  );
  lines.push(
    `| Success Rate | ${metrics.successRatePercent.toFixed(1)}% | ${metrics.successRatePercent >= 99 ? "✅" : "⚠️"} |`,
  );
  lines.push("");

  lines.push("### Latency Statistics (ms)");
  lines.push("");
  lines.push("| Metric | Latency |");
  lines.push("| :--- | :--- |");
  lines.push(`| Min | ${metrics.latency.min} ms |`);
  lines.push(`| Average | ${metrics.latency.avg} ms |`);
  lines.push(`| Median (p50) | ${metrics.latency.p50} ms |`);
  lines.push(`| 90th percentile (p90) | ${metrics.latency.p90} ms |`);
  lines.push(`| 95th percentile (p95) | ${metrics.latency.p95} ms |`);
  lines.push(`| 99th percentile (p99) | ${metrics.latency.p99} ms |`);
  lines.push(`| Max | ${metrics.latency.max} ms |`);
  lines.push("");

  if (Object.keys(metrics.errorCounts).length > 0) {
    lines.push("### Failure Breakdown");
    lines.push("");
    lines.push("| Error / Failure Reason | Count |");
    lines.push("| :--- | :--- |");
    for (const [err, count] of Object.entries(metrics.errorCounts)) {
      lines.push(`| \`${err}\` | ${count} |`);
    }
    lines.push("");
  }

  if (metrics.uniqueTxHashes.length > 0) {
    lines.push("### Sample Testnet Settlements");
    lines.push("");
    const samples = metrics.uniqueTxHashes.slice(0, 5);
    for (const hash of samples) {
      lines.push(
        `- [\`${hash.slice(0, 16)}...\`](https://stellar.expert/explorer/testnet/tx/${hash})`,
      );
    }
    if (metrics.uniqueTxHashes.length > 5) {
      lines.push(
        `- ... and ${metrics.uniqueTxHashes.length - 5} more unique settlement transactions.`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function runConcurrentPayments(
  corridor: Corridor,
  deps: EngineDeps,
  store: {
    get: (
      key: string,
    ) => Promise<{ state: string; stellarTxHash?: string; lastError?: string } | undefined>;
  },
  options: {
    concurrency: number;
    amount: string;
    senderSep12Id: string;
    recipientSep12Id: string;
  },
): Promise<readonly PaymentAttemptResult[]> {
  const { concurrency, amount, senderSep12Id, recipientSep12Id } = options;
  const batchId = Date.now();

  const tasks = Array.from({ length: concurrency }, async (_, idx) => {
    const paymentId = idx + 1;
    const idempotencyKey = `load-test-${batchId}-${paymentId}`;
    const intent: PaymentIntent = {
      idempotencyKey,
      corridorId: corridor.id,
      sender: {
        id: `sender-load-${paymentId}`,
        jurisdiction: corridor.compliance.source_jurisdiction,
        sep12Id: senderSep12Id,
      },
      recipient: {
        id: `recipient-load-${paymentId}`,
        jurisdiction: corridor.compliance.dest_jurisdiction,
        sep12Id: recipientSep12Id,
      },
      sourceAmount: { asset: corridor.settlement.bridge_asset, amount },
      destinationFields: {
        receiver_routing_number: "021000021",
        receiver_account_number: `1234567890${String(paymentId).padStart(4, "0")}`,
        type: "SWIFT",
      },
    };

    const startTime = Date.now();
    try {
      const result = await execute(intent, corridor, deps);
      const latencyMs = Date.now() - startTime;
      const stored = await store.get(idempotencyKey);

      if (result.ok && result.value.state === "completed") {
        return {
          index: paymentId,
          idempotencyKey,
          ok: true,
          state: result.value.state,
          latencyMs,
          stellarTxHash: stored?.stellarTxHash,
        };
      }

      return {
        index: paymentId,
        idempotencyKey,
        ok: false,
        state: stored?.state ?? (result.ok ? result.value.state : "failed"),
        latencyMs,
        stellarTxHash: stored?.stellarTxHash,
        error: !result.ok
          ? `${result.error.code}: ${result.error.message}`
          : stored?.lastError,
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      return {
        index: paymentId,
        idempotencyKey,
        ok: false,
        state: "exception",
        latencyMs,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  return Promise.all(tasks);
}

function resolveManifestPath(): string {
  const p = process.env.MANIFEST ?? "corridors/reference.corridor.yaml";
  return p.startsWith("/") ? p : fileURLToPath(new URL(`../${p}`, import.meta.url));
}

export async function main(): Promise<void> {
  const manifestPath = resolveManifestPath();
  const loaded = loadCorridor(manifestPath);
  if (!loaded.ok) {
    console.error(`✗ manifest error: ${loaded.error.message}`);
    process.exit(EXIT_MANIFEST);
  }

  // Refuse mainnet corridor
  if (loaded.value.settlement.network === "public") {
    console.error(
      `✗ corridor "${loaded.value.id}" settles on MAINNET (network=public). Load testing refuses to move real money.`,
    );
    process.exit(EXIT_REFUSED);
  }

  const anchorUrl = (process.env.REFERENCE_ANCHOR_URL ?? "http://localhost:8080").replace(
    /\/+$/,
    "",
  );
  const horizonUrl = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
  const concurrency = parseInt(process.env.CONCURRENCY ?? "100", 10);
  const amount = process.env.AMOUNT ?? "0.10";

  const corridor = pinToReferenceAnchor(loaded.value, anchorUrl);

  if (!process.env.SKIP_DOCTOR) {
    const doc = preflightDoctor();
    if (!doc.ok) {
      console.error(`✗ reference anchor doctor check failed: ${doc.error ?? "unfit stack"}`);
      process.exit(EXIT_STACK_UNFIT);
    }
  }

  const quotable = await assertAssetQuotable(corridor, anchorUrl);
  if (!quotable.ok) {
    console.error(`✗ asset not quotable: ${quotable.error}`);
    process.exit(quotable.refused ? EXIT_REFUSED : EXIT_STACK_UNFIT);
  }

  const signerSecret = process.env.CORRIDOR_SIGNER_SECRET;
  if (!signerSecret) {
    console.error("✗ missing required env var CORRIDOR_SIGNER_SECRET");
    process.exit(EXIT_MISSING_ENV);
  }

  const wired = wireCorridorDeps(corridor, {
    signerSecret,
    horizonUrl,
  });
  const { deps, signer, adapter, store } = wired;

  console.log(`\n======================================================`);
  console.log(`Starting Load Test: ${concurrency} concurrent payments`);
  console.log(`  Corridor:  ${corridor.id}`);
  console.log(`  Anchor:    ${anchorUrl}`);
  console.log(`  Horizon:   ${horizonUrl}`);
  console.log(`  Signer:    ${signer.publicKey}`);
  console.log(`  Amount:    ${amount} ${corridor.settlement.bridge_asset}`);
  console.log(`======================================================\n`);

  const senderReg = await registerSep12Customer(
    adapter,
    "sender",
    corridor.compliance.sep12_sender_type,
  );
  if (!senderReg.ok) {
    console.error(`✗ SEP-12 sender registration failed: ${senderReg.error.message}`);
    process.exit(EXIT_NOT_COMPLETED);
  }
  const receiverReg = await registerSep12Customer(
    adapter,
    "receiver",
    corridor.compliance.sep12_receiver_type,
  );
  if (!receiverReg.ok) {
    console.error(`✗ SEP-12 receiver registration failed: ${receiverReg.error.message}`);
    process.exit(EXIT_NOT_COMPLETED);
  }

  const startTime = Date.now();
  const results = await runConcurrentPayments(corridor, deps, store, {
    concurrency,
    amount,
    senderSep12Id: senderReg.value,
    recipientSep12Id: receiverReg.value,
  });
  const totalDurationMs = Date.now() - startTime;

  const metrics = computeMetrics(results, totalDurationMs);
  const report = formatMarkdownReport(metrics, {
    corridorId: corridor.id,
    concurrency,
    amount,
    anchorUrl,
  });

  console.log(report);

  // Write to GitHub Step Summary if present
  const summaryPath = process.env.GITHUB_STEP_SUMMARY ?? process.env.SUMMARY_FILE;
  if (summaryPath) {
    try {
      appendFileSync(summaryPath, report + "\n", "utf8");
      console.log(`\n✓ Written report to step summary: ${summaryPath}`);
    } catch (err) {
      console.warn(`Warning: Could not write step summary to ${summaryPath}: ${String(err)}`);
    }
  }

  // Acceptance criteria: No duplicate settlements
  const duplicates = detectDuplicateSettlements(results);
  if (duplicates.hasDuplicates) {
    console.error(
      `\n❌ DUPLICATE SETTLEMENTS DETECTED: ${duplicates.duplicateHashes.join(", ")}`,
    );
    process.exit(EXIT_NOT_COMPLETED);
  }

  if (metrics.failed > 0) {
    console.error(`\n⚠️ Load test finished with ${metrics.failed} failure(s).`);
    process.exit(EXIT_NOT_COMPLETED);
  }

  console.log(
    `\n✓ Load test passed: 100% of ${metrics.total} concurrent payments settled with zero duplicates.`,
  );
}

// Run main if called directly
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
