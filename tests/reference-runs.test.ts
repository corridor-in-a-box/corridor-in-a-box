import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HISTORY_PATH,
  MAX_RUNS,
  appendRun,
  buildRecord,
  parseRuns,
  parseTrail,
  parseTxHashes,
  serializeRuns,
  type ReferenceRun,
} from "../scripts/reference-runs";
import {
  latestReferenceRun,
  referenceRuns,
  summarizeReferenceRuns,
} from "../web/lib/reference-runs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const SETTLE_TX = "81c4642216b884100b34fa018462bb9cd7587886307d59d923dccbf87011b630";

const LOG = [
  'verifying corridor "reference-testnet" against http://localhost:8080',
  "trail: created -> quoted -> compliant -> opened -> verifying -> settling -> settled -> reconciled -> completed",
  `stellar tx: ${SETTLE_TX}`,
  `explorer:   https://stellar.expert/explorer/testnet/tx/${SETTLE_TX}`,
  "✓ corridor completed end to end against the reference anchor",
].join("\n");

const record = (over: Partial<ReferenceRun> = {}): ReferenceRun => ({
  runId: 1,
  date: "2026-11-17T05:43:00.000Z",
  outcome: "success",
  durationSeconds: 600,
  trail: ["created", "completed"],
  txHashes: [SETTLE_TX],
  runUrl: "https://github.com/corridor-in-a-box/corridor-in-a-box/actions/runs/1",
  ...over,
});

describe("reading a corridor run's output", () => {
  it("takes the trail from the printed line, whatever the arrow", () => {
    expect(parseTrail(LOG).slice(0, 3)).toEqual(["created", "quoted", "compliant"]);
    expect(parseTrail(LOG).at(-1)).toBe("completed");
    expect(parseTrail("created → quoted → completed")).toEqual([]);
    expect(parseTrail("trail: created → quoted")).toEqual(["created", "quoted"]);
    expect(parseTrail("no trail here")).toEqual([]);
  });

  it("collects each transaction hash once, lowercased", () => {
    // The log prints the hash twice: as `stellar tx:` and in the explorer link.
    expect(parseTxHashes(LOG)).toEqual([SETTLE_TX]);
    expect(parseTxHashes(`stellar tx: ${SETTLE_TX.toUpperCase()}`)).toEqual([SETTLE_TX]);
  });
});

describe("buildRecord", () => {
  it("records a successful run with its trail, transaction and duration", () => {
    const built = buildRecord({
      runId: 43969161708,
      runUrl: "https://github.com/o/r/actions/runs/43969161708",
      startedAt: "2026-11-17T05:43:00Z",
      finishedAt: "2026-11-17T05:53:30Z",
      exitCode: 0,
      log: LOG,
    });

    expect(built.outcome).toBe("success");
    expect(built.date).toBe("2026-11-17T05:43:00.000Z");
    expect(built.durationSeconds).toBe(630);
    expect(built.trail).toHaveLength(9);
    expect(built.txHashes).toEqual([SETTLE_TX]);
  });

  it("records a failed run as failed, with whatever output it produced", () => {
    const built = buildRecord({
      runId: 7,
      runUrl: "https://github.com/o/r/actions/runs/7",
      startedAt: "2026-11-18T05:43:00Z",
      finishedAt: "2026-11-18T05:44:00Z",
      exitCode: 1,
      log: "trail: created -> quoted -> failed\n✗ CORRIDOR_HALTED — anchor unavailable",
    });

    expect(built.outcome).toBe("failure");
    expect(built.durationSeconds).toBe(60);
    expect(built.trail).toEqual(["created", "quoted", "failed"]);
    expect(built.txHashes).toEqual([]);
  });

  it("records a run that never started as cancelled or failed", () => {
    const base = {
      runId: 8,
      runUrl: "https://github.com/o/r/actions/runs/8",
      startedAt: "2026-11-19T05:43:00Z",
      finishedAt: "2026-11-19T05:43:05Z",
      exitCode: 1,
    };

    expect(buildRecord({ ...base, cancelled: true }).outcome).toBe("cancelled");
    expect(buildRecord(base).outcome).toBe("failure");
  });

  it("refuses timestamps it cannot read", () => {
    expect(() =>
      buildRecord({
        runId: 9,
        runUrl: "https://github.com/o/r/actions/runs/9",
        startedAt: "yesterday",
        finishedAt: new Date().toISOString(),
        exitCode: 0,
      }),
    ).toThrow(/unparseable timestamps/);
  });
});

describe("appendRun", () => {
  const older = record({ runId: 1, date: "2026-11-17T05:43:00.000Z" });
  const newer = record({ runId: 2, date: "2026-11-18T05:43:00.000Z" });

  it("keeps the newest run first", () => {
    expect(appendRun([older], newer).map((r) => r.runId)).toEqual([2, 1]);
    expect(appendRun([newer], older).map((r) => r.runId)).toEqual([2, 1]);
  });

  it("replaces a retried run instead of adding a second record for it", () => {
    const retried = record({ runId: 2, date: newer.date, outcome: "failure" });
    const runs = appendRun([newer, older], retried);

    expect(runs).toHaveLength(2);
    expect(runs.filter((r) => r.runId === 2)).toHaveLength(1);
    expect(runs[0]!.outcome).toBe("failure");
  });

  it("caps the history, dropping the oldest records", () => {
    const many = Array.from({ length: MAX_RUNS }, (_, i) =>
      record({
        runId: i + 1,
        date: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString(),
      }),
    );
    const next = record({ runId: MAX_RUNS + 1, date: "2027-01-01T00:00:00.000Z" });
    const runs = appendRun(many, next);

    expect(runs).toHaveLength(MAX_RUNS);
    expect(runs[0]!.runId).toBe(MAX_RUNS + 1);
    expect(runs.at(-1)!.runId).toBe(2);
  });

  it("does not mutate the input", () => {
    const history = [older];
    appendRun(history, newer);
    expect(history).toEqual([older]);
  });
});

describe("parseRuns", () => {
  it("round-trips what serializeRuns writes", () => {
    const runs = [record({ runId: 2 }), record({ runId: 1 })];
    expect(parseRuns(serializeRuns(runs))).toEqual(runs);
  });

  it("rejects a corrupt history rather than silently starting over", () => {
    expect(() => parseRuns("not json")).toThrow(/not JSON/);
    expect(() => parseRuns("[]")).toThrow(/expected/);
    expect(() => parseRuns('{"runs":[{"runId":1}]}')).toThrow(/runs\[0\]/);
    expect(() => parseRuns(serializeRuns([record({ txHashes: ["nope"] })]))).toThrow(
      /txHashes/,
    );
    expect(() => parseRuns(serializeRuns([record({ outcome: "held" as never })]))).toThrow(
      /outcome/,
    );
  });
});

describe("the published history", () => {
  const committed = readFileSync(join(repoRoot, HISTORY_PATH), "utf8");
  const runs = parseRuns(committed.replace(/\r\n/g, "\n"));

  it("is valid and newest first, so the web app can read it", () => {
    for (let i = 1; i < runs.length; i += 1) {
      expect(Date.parse(runs[i - 1]!.date)).toBeGreaterThanOrEqual(Date.parse(runs[i]!.date));
    }
    expect(committed.replace(/\r\n/g, "\n")).toBe(serializeRuns(runs));
  });

  it("is the same array the web app imports", () => {
    expect(referenceRuns).toEqual(runs);
    expect(latestReferenceRun()).toEqual(runs[0]);
  });
});

describe("summarizeReferenceRuns", () => {
  it("reports the success rate and average duration the trend is for", () => {
    const summary = summarizeReferenceRuns([
      record({ runId: 3, outcome: "success", durationSeconds: 600 }),
      record({ runId: 2, outcome: "failure", durationSeconds: 300 }),
      record({ runId: 1, outcome: "cancelled", durationSeconds: 0 }),
    ]);

    expect(summary).toEqual({
      runs: 3,
      succeeded: 1,
      failed: 1,
      cancelled: 1,
      successRate: 1 / 3,
      averageDurationSeconds: 300,
    });
  });

  it("is empty, not NaN, before the first run", () => {
    expect(summarizeReferenceRuns([])).toEqual({
      runs: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      successRate: 0,
      averageDurationSeconds: 0,
    });
  });

  it("summarizes the committed history", () => {
    expect(summarizeReferenceRuns(referenceRuns).runs).toBe(referenceRuns.length);
  });
});

describe("the nightly workflow publishes the history", () => {
  const workflow = readFileSync(
    join(repoRoot, ".github/workflows/reference-corridor.yml"),
    "utf8",
  );

  it("records every run, not only successful ones", () => {
    expect(workflow).toContain("pnpm record:reference-run");
    // A failure must not skip the record step, or the history has no failures.
    const recordStep = workflow.slice(workflow.indexOf("name: Record the run"));
    expect(recordStep.slice(0, 200)).toContain("always()");
  });

  it("commits the file the web app reads", () => {
    expect(workflow).toContain(HISTORY_PATH);
    expect(workflow).toMatch(/contents:\s*write/);
  });
});
