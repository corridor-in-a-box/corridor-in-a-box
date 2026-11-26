import { describe, expect, it } from "vitest";
import {
  ATTESTATION_PENALTY_LEDGERS,
  MIN_RELIABILITY_RUNS,
  RELIABILITY_WINDOW_MS,
  reliability,
  type ReliabilityDeps,
  type ReliabilityRun,
  type ReliabilityRunOutcome,
} from "@corridor/router";

const NOW = 1_800_000_000_000;
const ANCHOR = "anchor.example";

function runs(
  count: number,
  outcome: ReliabilityRunOutcome,
  at = NOW - 60_000,
  anchor = ANCHOR,
): ReliabilityRun[] {
  return Array.from({ length: count }, () => ({ anchor, at, outcome }));
}

function deps(
  history: readonly ReliabilityRun[],
  staleness: number | "missing" | "throws" = 0,
): ReliabilityDeps {
  return {
    runs: {
      listOutcomes: async () => history,
    },
    attestation: {
      staleness: async () => {
        if (staleness === "throws") throw new Error("no attestation on file");
        if (staleness === "missing") return undefined;
        return staleness;
      },
    },
    now: () => NOW,
  };
}

describe("reliability", () => {
  it("is the plain 30-day success rate once enough runs exist", async () => {
    const history = [...runs(15, "success"), ...runs(5, "failure", NOW - 120_000)];
    expect(history.length).toBe(MIN_RELIABILITY_RUNS);
    expect(await reliability(ANCHOR, deps(history))).toBe(0.75);
  });

  it("shrinks small samples toward 0.5 instead of assuming success", async () => {
    expect(await reliability(ANCHOR, deps([]))).toBe(0.5);
    expect(await reliability(ANCHOR, deps(runs(1, "success")))).toBe(0.525);
    expect(await reliability(ANCHOR, deps(runs(1, "failure")))).toBe(0.475);
    expect(await reliability(ANCHOR, deps(runs(10, "success")))).toBe(0.75);
  });

  it("counts only this anchor's runs inside the window", async () => {
    const history = [
      ...runs(MIN_RELIABILITY_RUNS, "success", NOW - RELIABILITY_WINDOW_MS),
      ...runs(3, "failure", NOW - RELIABILITY_WINDOW_MS - 1),
      ...runs(3, "failure", NOW + 1),
      ...runs(3, "failure", NOW - 1_000, "other.example"),
    ];
    expect(await reliability(ANCHOR, deps(history))).toBe(1);
  });

  it("decays linearly with attestation age and reaches zero at the freshness bound", async () => {
    const history = runs(MIN_RELIABILITY_RUNS, "success");
    const half = ATTESTATION_PENALTY_LEDGERS / 2;
    expect(await reliability(ANCHOR, deps(history, 0))).toBe(1);
    expect(await reliability(ANCHOR, deps(history, half))).toBe(0.5);
    expect(await reliability(ANCHOR, deps(history, ATTESTATION_PENALTY_LEDGERS))).toBe(0);
    expect(await reliability(ANCHOR, deps(history, ATTESTATION_PENALTY_LEDGERS + 1))).toBe(0);
    expect(await reliability(ANCHOR, deps(history, -1))).toBe(1);
  });

  it("scores zero when the attestation is unknown, and stays within 0..1", async () => {
    const history = runs(MIN_RELIABILITY_RUNS, "success");
    expect(await reliability(ANCHOR, deps(history, "missing"))).toBe(0);
    expect(await reliability(ANCHOR, deps(history, "throws"))).toBe(0);
    expect(await reliability("", deps(history))).toBe(0);

    const score = await reliability(
      "ANCHOR.EXAMPLE",
      deps(history, ATTESTATION_PENALTY_LEDGERS / 2),
    );
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});
