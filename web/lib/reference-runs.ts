// The nightly reference-corridor history (#680), for the dashboard.
//
// The file is written by scripts/record-reference-run.ts from the nightly
// workflow and committed to ./generated/reference-runs.json, so the site renders
// it at build time with no API call and no rate limit. #586's "latest real run"
// panel reads the first row of the same array, which is why the newest record
// is first and carries the same run id, trail and transaction hashes the panel
// shows.

import generated from "./generated/reference-runs.json";

export type ReferenceRunOutcome = "success" | "failure" | "cancelled";

export interface ReferenceRun {
  /** GitHub Actions run id. */
  runId: number;
  /** When the run started, ISO 8601 UTC. */
  date: string;
  outcome: ReferenceRunOutcome;
  durationSeconds: number;
  trail: string[];
  txHashes: string[];
  /** The workflow run's page on GitHub. */
  runUrl: string;
}

/** Every recorded run, newest first, exactly as the nightly workflow wrote it. */
export const referenceRuns = (generated as { runs: ReferenceRun[] }).runs;

/** The most recent run, or undefined before the first nightly record. */
export function latestReferenceRun(
  runs: readonly ReferenceRun[] = referenceRuns,
): ReferenceRun | undefined {
  return runs[0];
}

export interface ReferenceRunSummary {
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  /** 0–1; 0 when nothing has been recorded yet. */
  successRate: number;
  averageDurationSeconds: number;
}

/**
 * The trend the history exists for: how often the corridor completes, and how
 * long it takes. Cancelled runs count against the success rate but are not
 * called failures.
 */
export function summarizeReferenceRuns(
  runs: readonly ReferenceRun[] = referenceRuns,
): ReferenceRunSummary {
  const succeeded = runs.filter((run) => run.outcome === "success").length;
  const failed = runs.filter((run) => run.outcome === "failure").length;
  const cancelled = runs.filter((run) => run.outcome === "cancelled").length;
  const total = runs.length;
  const duration = runs.reduce((sum, run) => sum + run.durationSeconds, 0);

  return {
    runs: total,
    succeeded,
    failed,
    cancelled,
    successRate: total === 0 ? 0 : succeeded / total,
    averageDurationSeconds: total === 0 ? 0 : Math.round(duration / total),
  };
}
