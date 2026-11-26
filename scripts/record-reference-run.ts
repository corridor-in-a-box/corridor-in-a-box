// Appends this reference-corridor run to the history the web app reads (#680).
//
//   pnpm record:reference-run
//
// Called by the `publish-history` job of .github/workflows/reference-corridor.yml,
// which runs `if: always()`, so a failed nightly is recorded too — a history of
// green runs only cannot show a success rate. That job holds no secrets and runs
// no `pnpm install`: it calls this file with plain `node --experimental-strip-types`,
// which is why the import below names `./reference-runs.ts` and this file must
// stay free of anything type stripping cannot erase (enums, namespaces, path
// aliases, packages). The job commits the file afterwards.
//
// Inputs come from the Actions environment rather than arguments, because the
// failure being recorded is often the one just before this step:
//
//   GITHUB_RUN_ID          the run to record (required)
//   GITHUB_SERVER_URL      default https://github.com
//   GITHUB_REPOSITORY      default corridor-in-a-box/corridor-in-a-box
//   RUN_STARTED_AT         ISO 8601; the workflow sets this before the stack boots
//   RUN_FINISHED_AT        ISO 8601; default now
//   RUN_EXIT / CORRIDOR_EXIT  the runner's exit status; anything but 0 is a failure
//   RUN_CANCELLED           "true" when the run was cancelled
//   RUN_LOG                captured output to read the trail and tx from
//                          (default corridor-run.log)
//
// A corrupt history is never overwritten: the script exits non-zero instead.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HISTORY_PATH,
  appendRun,
  buildRecord,
  parseRuns,
  serializeRuns,
} from "./reference-runs.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const env = process.env;

const runId = Number(env.GITHUB_RUN_ID);
if (!Number.isInteger(runId) || runId <= 0) {
  console.error("record-reference-run: GITHUB_RUN_ID is required and must be a run id");
  process.exit(1);
}

const server = env.GITHUB_SERVER_URL ?? "https://github.com";
const repo = env.GITHUB_REPOSITORY ?? "corridor-in-a-box/corridor-in-a-box";
const runUrl = `${server}/${repo}/actions/runs/${runId}`;

const finishedAt = env.RUN_FINISHED_AT ?? new Date().toISOString();
// No start marker means the job died before it was set; a zero-length record is
// still better than no record, and the outcome already says it failed.
const startedAt = env.RUN_STARTED_AT ?? finishedAt;

// An unset exit status is a failure: the corridor runner is the only step that
// sets it, so its absence means the run never got that far.
const rawExit = env.RUN_EXIT ?? env.CORRIDOR_EXIT;
const exitCode = rawExit === undefined || rawExit === "" ? 1 : Number(rawExit);
if (!Number.isInteger(exitCode)) {
  console.error(`record-reference-run: RUN_EXIT "${rawExit}" is not an integer`);
  process.exit(1);
}

const logPath = resolve(repoRoot, env.RUN_LOG ?? "corridor-run.log");
const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
if (log === "") {
  console.warn(
    `record-reference-run: no output at ${env.RUN_LOG ?? "corridor-run.log"}; ` +
      "recording the run without a trail or transaction",
  );
}

const historyPath = join(repoRoot, HISTORY_PATH);
const previous = existsSync(historyPath) ? parseRuns(readFileSync(historyPath, "utf8")) : [];

const record = buildRecord({
  runId,
  runUrl,
  startedAt,
  finishedAt,
  exitCode,
  cancelled: env.RUN_CANCELLED === "true",
  log,
});
const runs = appendRun(previous, record);

writeFileSync(historyPath, serializeRuns(runs));
console.log(
  `recorded run ${runId}: ${record.outcome}, ${record.durationSeconds}s, ` +
    `${record.trail.length} states, ${record.txHashes.length} tx ` +
    `(${runs.length} runs in ${HISTORY_PATH})`,
);
