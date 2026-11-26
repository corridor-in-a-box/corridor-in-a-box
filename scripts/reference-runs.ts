// The history of nightly reference-corridor runs (#680).
//
// #586 puts the LATEST real run on the dashboard by reading the GitHub Actions
// API. This file is the other half of the same story: a record of every run,
// appended by the nightly workflow and committed to
// web/lib/generated/reference-runs.json, so the site can show trends (success
// rate, duration) without another API call or an unauthenticated rate limit.
//
// The record is deliberately small and machine-readable: date, outcome,
// duration, the state trail and the settle transaction hashes. It is written by
// scripts/record-reference-run.ts, read by web/lib/reference-runs.ts, and
// guarded by tests/reference-runs.test.ts.
//
// Newest first. A re-run of the same workflow run id REPLACES its record rather
// than appending a second one, so a retried nightly cannot skew the success
// rate.

export const HISTORY_PATH = "web/lib/generated/reference-runs.json";

/** How many nightly runs to keep: six months, enough for a trend line. */
export const MAX_RUNS = 180;

export type ReferenceRunOutcome = "success" | "failure" | "cancelled";

const OUTCOMES: readonly ReferenceRunOutcome[] = ["success", "failure", "cancelled"];

export interface ReferenceRun {
  /** GitHub Actions run id. Unique, and the key a re-run replaces. */
  runId: number;
  /** When the run started, ISO 8601 UTC. */
  date: string;
  outcome: ReferenceRunOutcome;
  /** Wall-clock duration, including the reference stack coming up. */
  durationSeconds: number;
  /** The engine's trail in order, e.g. ["created", "quoted", …]. */
  trail: string[];
  /** Stellar transaction hashes the run printed (the settle leg, usually). */
  txHashes: string[];
  /** The workflow run's page, so a record can be checked against its log. */
  runUrl: string;
}

export interface RunFacts {
  runId: number;
  runUrl: string;
  startedAt: string;
  finishedAt: string;
  /** The corridor runner's exit status; 0 is the only success. */
  exitCode: number | undefined;
  cancelled?: boolean;
  /** The run's captured output, used for the trail and tx hashes. */
  log?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

const isIsoDate = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));

function fail(message: string): never {
  throw new Error(`reference-runs: ${message}`);
}

/**
 * Parse the published file, rejecting anything the web app could not render.
 * A corrupt history must stop the nightly writer rather than be overwritten —
 * the accumulated records are the only copy of the trend.
 */
export function parseRuns(text: string): ReferenceRun[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    fail(`history is not JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!isObject(parsed) || !Array.isArray(parsed.runs)) fail('expected {"runs": [...]}');

  return (parsed.runs as unknown[]).map((raw, i) => {
    const where = `runs[${i}]`;
    if (!isObject(raw)) fail(`${where} is not an object`);

    const { runId, date, outcome, durationSeconds, trail, txHashes, runUrl } = raw;
    if (typeof runId !== "number" || !Number.isInteger(runId) || runId <= 0) {
      fail(`${where}.runId is not a positive integer`);
    }
    if (!isIsoDate(date)) fail(`${where}.date is not an ISO date`);
    if (typeof outcome !== "string" || !OUTCOMES.includes(outcome as ReferenceRunOutcome)) {
      fail(`${where}.outcome is not one of ${OUTCOMES.join(", ")}`);
    }
    if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds)) {
      fail(`${where}.durationSeconds is not a number`);
    }
    if (!Array.isArray(trail) || trail.some((s) => typeof s !== "string")) {
      fail(`${where}.trail is not a list of state names`);
    }
    if (!Array.isArray(txHashes) || !txHashes.every(isHash)) {
      fail(`${where}.txHashes is not a list of 64-char hex hashes`);
    }
    if (typeof runUrl !== "string" || !/^https?:\/\//.test(runUrl)) {
      fail(`${where}.runUrl is not an http(s) URL`);
    }

    return {
      runId,
      date,
      outcome: outcome as ReferenceRunOutcome,
      durationSeconds,
      trail: trail as string[],
      txHashes: txHashes as string[],
      runUrl,
    };
  });
}

/** The trail `pnpm verify:corridor` prints, e.g. `trail: created -> quoted -> …`. */
export function parseTrail(log: string): string[] {
  const line = /^trail:\s*(.+)$/m.exec(log)?.[1];
  if (!line) return [];
  return line
    .split(/->|→/)
    .map((state) => state.trim())
    .filter(Boolean);
}

/**
 * Every transaction hash the log prints, in first-seen order. `verify:corridor`
 * prints both `stellar tx: <hash>` and a stellar.expert link for it.
 */
export function parseTxHashes(log: string): string[] {
  const seen = new Set<string>();
  const pattern = /(?:stellar tx:|explorer:\s*\S*\/tx\/)\s*([0-9a-fA-F]{64})/g;
  for (const match of log.matchAll(pattern)) {
    seen.add(match[1]!.toLowerCase());
  }
  return [...seen];
}

export function buildRecord(facts: RunFacts): ReferenceRun {
  const started = Date.parse(facts.startedAt);
  const finished = Date.parse(facts.finishedAt);
  if (Number.isNaN(started) || Number.isNaN(finished)) {
    fail(`unparseable timestamps ${facts.startedAt} → ${facts.finishedAt}`);
  }

  const log = facts.log ?? "";
  const outcome: ReferenceRunOutcome = facts.cancelled
    ? "cancelled"
    : facts.exitCode === 0
      ? "success"
      : "failure";

  return {
    runId: facts.runId,
    date: new Date(started).toISOString(),
    outcome,
    durationSeconds: Math.max(0, Math.round((finished - started) / 1000)),
    trail: parseTrail(log),
    txHashes: parseTxHashes(log),
    runUrl: facts.runUrl,
  };
}

/**
 * Add a record, newest first. Same run id replaces the earlier record (a retried
 * nightly is one run, not two), and the list is capped at `max`.
 */
export function appendRun(
  runs: readonly ReferenceRun[],
  record: ReferenceRun,
  max = MAX_RUNS,
): ReferenceRun[] {
  return [...runs.filter((run) => run.runId !== record.runId), record]
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || b.runId - a.runId)
    .slice(0, max);
}

/** The committed file's exact bytes: 2-space JSON, trailing newline. */
export function serializeRuns(runs: readonly ReferenceRun[]): string {
  return JSON.stringify({ runs }, null, 2) + "\n";
}
