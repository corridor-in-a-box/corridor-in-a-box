/** Only runs in the 30 days before `now` count, as RFC 0004 requires. */
export const RELIABILITY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Below this many counted runs, the observed rate is shrunk toward 0.5 so one
 * early success or failure cannot decide an anchor's score.
 */
export const MIN_RELIABILITY_RUNS = 20;

/**
 * An attestation this old contributes no reliability. Matches the router's
 * one-week freshness bound (120,960 ledgers at 5s), so a score can never be
 * propped up by evidence the gate would refuse.
 */
export const ATTESTATION_PENALTY_LEDGERS = 120_960;

export type ReliabilityRunOutcome = "success" | "failure";

/** One business-owned run outcome, as projected from the run store. */
export interface ReliabilityRun {
  /** Receiving anchor's home domain. Case-insensitive. */
  readonly anchor: string;
  /** Epoch milliseconds, matching the engine's other timestamps. */
  readonly at: number;
  readonly outcome: ReliabilityRunOutcome;
}

/**
 * Read-only projection of the run store. The implementation decides which
 * stored run states are successes and failures; this scorer only counts the
 * outcomes it is given.
 */
export interface ReliabilityRunStore {
  listOutcomes(
    anchor: string,
    since: number,
  ): Promise<readonly ReliabilityRun[]> | readonly ReliabilityRun[];
}

/** `AttestationSource.staleness` is assignable; `undefined` means no attestation on file. */
export interface ReliabilityAttestationSource {
  staleness(domain: string): Promise<number | undefined> | number | undefined;
}

export interface ReliabilityDeps {
  readonly runs: ReliabilityRunStore;
  /** On-chain attestation age, from the same source the registry resolver uses. */
  readonly attestation: ReliabilityAttestationSource;
  readonly now?: () => number;
}

/**
 * RFC 0004 reliability for one receiving anchor, in 0..1: this business's
 * success rate on that anchor over the last 30 days, reduced when the anchor's
 * attestation is old.
 *
 * Window: runs with `at` in `[now - 30 days, now]` count. Older runs, future
 * runs and runs for another anchor are ignored. The run store is asked for
 * `since` as an optimisation; the filter is repeated here so a loose store
 * cannot silently widen the window.
 *
 * Not enough runs: with fewer than `MIN_RELIABILITY_RUNS` counted runs, the
 * observed rate is linearly shrunk toward 0.5 — `0.5 + (rate - 0.5) * n/20`.
 * Zero runs therefore score 0.5 (unknown evidence is not assumed good), one
 * success scores 0.525, and 20 counted runs score the plain success rate.
 *
 * Attestation-age penalty: the base rate is multiplied by
 * `max(0, 1 - stalenessLedgers / 120_960)`. A fresh attestation leaves the
 * score unchanged, one half a week old halves it, and an attestation at or
 * beyond the router's one-week freshness bound reduces it to 0. Negative
 * staleness is treated as fresh. An attestation that cannot be read (including
 * "no attestation on file") is unknown evidence and scores 0.
 */
export async function reliability(anchor: string, deps: ReliabilityDeps): Promise<number> {
  const domain = anchor.trim().toLowerCase();
  if (domain === "") return 0;

  const now = deps.now?.() ?? Date.now();
  const since = now - RELIABILITY_WINDOW_MS;
  const history = await deps.runs.listOutcomes(domain, since);

  let successes = 0;
  let failures = 0;
  for (const run of history) {
    if (run.anchor.trim().toLowerCase() !== domain) continue;
    if (!Number.isFinite(run.at) || run.at < since || run.at > now) continue;
    if (run.outcome === "success") successes += 1;
    else if (run.outcome === "failure") failures += 1;
  }

  const total = successes + failures;
  const observed = total === 0 ? 0.5 : successes / total;
  const base =
    total >= MIN_RELIABILITY_RUNS
      ? observed
      : 0.5 + (observed - 0.5) * (total / MIN_RELIABILITY_RUNS);

  let staleness: number;
  try {
    const value: number | undefined = await deps.attestation.staleness(domain);
    if (value === undefined || !Number.isFinite(value)) return 0;
    staleness = Math.max(0, value);
  } catch {
    return 0;
  }

  const ageFactor = Math.max(0, 1 - staleness / ATTESTATION_PENALTY_LEDGERS);
  return Math.min(1, Math.max(0, base * ageFactor));
}
