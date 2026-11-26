// Rate history: retention and pruning (#599, RFC 0004 §3).
//
// Raw rate samples arrive every 15 minutes for every series, so `rate_samples` grows quickly.
// Daily summaries (`rate_daily_summaries`) are kept forever; raw samples are kept for a
// configurable number of whole UTC days (default 90) and then pruned, once a day, by a step
// in the rate collector loop (`createPruningCollectorStep`), in bounded batches.
//
// The guard: a raw sample is deleted only when its series (network, sell asset, buy asset,
// source, anchor domain) has a `rate_daily_summaries` row for the sample's UTC day that was
// computed after the sample was recorded. A day with no summary, or a sample that arrived
// after its day was summarised, is kept. The guard is part of the DELETE itself, so no other
// code path can skip it. Samples are never pruned for being outliers (#602).
//
// Retention can never be set below 7 days: the minimum-data rule and the default `estimated`
// window (RFC 0004 D3 and §3) read the last 7 days of raw samples.
//
// The tables are created by `migrate()` (idempotency-pg.ts, from rate-samples-pg.ts). Pruning
// keeps no state of its own: re-running it is a no-op once a day's eligible rows are gone.

import type { Queryable } from "./idempotency-pg";
import { silentLogger, type Logger } from "./observability";
import type { CollectorStep, CollectorStepResult } from "./rate-collector-loop";

/** Default number of whole UTC days of raw samples to keep (#599). */
export const DEFAULT_RETENTION_DAYS = 90;

/**
 * The shortest retention allowed. The minimum-data rule (7 days of data) and the default
 * `estimated` window (the last 7 days, RFC 0004 D3) read raw samples, so they must survive.
 */
export const MIN_RETENTION_DAYS = 7;

/** Default rows deleted per batch, so no single statement holds locks for long. */
export const DEFAULT_PRUNE_BATCH_SIZE = 1_000;

/** Default batches per run. A larger backlog carries over to the next tick. */
export const DEFAULT_MAX_PRUNE_BATCHES = 100;

/** Default number of blocked (series, day) pairs a run reports. */
export const DEFAULT_BLOCKED_REPORT_LIMIT = 100;

const MAX_BATCH_SIZE = 10_000;
const DAY_MS = 86_400_000;

/**
 * Parse a retention period in whole days, e.g. from `RATE_RETENTION_DAYS`. Unset or empty
 * returns `fallback`. Anything that is not an integer of at least 7 throws a RangeError.
 */
export function parseRetentionDays(
  value?: string | number | null,
  fallback: number = DEFAULT_RETENTION_DAYS,
): number {
  if (value === undefined || value === null || value === "")
    return assertRetentionDays(fallback);
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) {
    throw new RangeError(
      `retention must be a whole number of days, at least ${MIN_RETENTION_DAYS}; got ${JSON.stringify(value)}`,
    );
  }
  return assertRetentionDays(typeof value === "number" ? value : Number(value.trim()));
}

function assertRetentionDays(days: number): number {
  if (!Number.isSafeInteger(days) || days < MIN_RETENTION_DAYS) {
    throw new RangeError(
      `retention must be a whole number of days, at least ${MIN_RETENTION_DAYS} (the minimum-data rule and the estimate window read the last 7 days of raw samples); got ${String(days)}`,
    );
  }
  return days;
}

function assertPositiveInteger(value: number, field: string, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${field} must be an integer from 1 to ${max}, got ${String(value)}`);
  }
}

/** The UTC calendar day of a time, as `YYYY-MM-DD`. */
export function utcDayString(at: Date | number = Date.now()): string {
  return new Date(typeof at === "number" ? at : at.getTime()).toISOString().slice(0, 10);
}

/**
 * The prune cutoff: midnight UTC `retentionDays` days before the start of today (UTC).
 * Samples taken strictly before it are eligible, so whole UTC days are pruned, today and the
 * `retentionDays` days before it are always kept, and no day is ever left half-pruned.
 */
export function calculateRetentionCutoff(
  retentionDays: number,
  now: Date | number = Date.now(),
): Date {
  assertRetentionDays(retentionDays);
  const nowMs = typeof now === "number" ? now : now.getTime();
  const startOfToday = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return new Date(startOfToday - retentionDays * DAY_MS);
}

/**
 * The guard, as a SQL predicate over a `rate_samples` row aliased `s`: its series has a
 * summary for its UTC day, computed after the sample was recorded. `anchor_domain` is null for
 * anchorless sources, so it is compared with `is not distinct from`.
 */
const SUMMARISED_SQL = `exists (
      select 1
      from rate_daily_summaries d
      where d.network = s.network
        and d.sell_asset = s.sell_asset
        and d.buy_asset = s.buy_asset
        and d.source = s.source
        and d.anchor_domain is not distinct from s.anchor_domain
        and d.day = (s.sampled_at at time zone 'UTC')::date
        and d.computed_at >= s.recorded_at
    )`;

/**
 * One batch: delete up to $2 of the oldest samples taken before $1 that pass the guard, and
 * return how many went. `skip locked` lets two collectors prune at once without waiting on
 * each other.
 */
export const PRUNE_RATE_SAMPLES_SQL = `
with doomed as (
  select s.id
  from rate_samples s
  where s.sampled_at < $1
    and ${SUMMARISED_SQL}
  order by s.sampled_at, s.id
  limit $2
  for update of s skip locked
), deleted as (
  delete from rate_samples r
  using doomed
  where r.id = doomed.id
  returning 1
)
select count(*)::int as deleted from deleted;
`;

/**
 * The (series, day) pairs older than $1 the guard keeps, with their sample counts, oldest
 * first, at most $2 of them: days not summarised yet, and days with samples recorded after
 * their summary was computed.
 */
export const SELECT_UNSUMMARIZED_DAYS_SQL = `
select s.network, s.sell_asset, s.buy_asset, s.source, s.anchor_domain,
       to_char((s.sampled_at at time zone 'UTC')::date, 'YYYY-MM-DD') as day,
       count(*)::int as samples
from rate_samples s
where s.sampled_at < $1
  and not ${SUMMARISED_SQL}
group by s.network, s.sell_asset, s.buy_asset, s.source, s.anchor_domain, day
order by day, s.network, s.sell_asset, s.buy_asset, s.source, s.anchor_domain nulls first
limit $2;
`;

/** One series and UTC day past the cutoff whose raw samples the guard kept. */
export interface UnsummarizedDayRecord {
  readonly network: string;
  readonly sellAsset: string;
  readonly buyAsset: string;
  readonly source: string;
  readonly anchorDomain: string | null;
  /** `YYYY-MM-DD`, UTC. */
  readonly day: string;
  /** Raw samples kept for that series and day. */
  readonly samples: number;
}

export interface RatePruningOptions {
  /** Whole UTC days of raw samples to keep, at least 7. Default 90. */
  readonly retentionDays?: number;
  /** Rows deleted per batch (1 to 10,000). Default 1,000. */
  readonly batchSize?: number;
  /** Batches per run. Default 100. */
  readonly maxBatches?: number;
  /** At most this many blocked (series, day) pairs are reported. Default 100. */
  readonly blockedReportLimit?: number;
  /** Clock, for tests. Default `Date.now`. */
  readonly now?: () => number | Date;
  /** Default `silentLogger`. */
  readonly logger?: Logger;
}

export interface RatePruningResult {
  /** UTC day the run happened, `YYYY-MM-DD`. */
  readonly day: string;
  /** ISO timestamp; samples taken before it were eligible. */
  readonly cutoff: string;
  readonly retentionDays: number;
  readonly rowsDeleted: number;
  readonly batches: number;
  /** False when `maxBatches` ran out with rows still eligible; the next run carries on. */
  readonly complete: boolean;
  /** Series-days past the cutoff the guard kept (at most `blockedReportLimit`). */
  readonly blocked: readonly UnsummarizedDayRecord[];
}

interface BlockedRow {
  network: string;
  sell_asset: string;
  buy_asset: string;
  source: string;
  anchor_domain: string | null;
  day: string;
  samples: number | string;
}

function resolveOptions(options: RatePruningOptions) {
  const retentionDays = assertRetentionDays(options.retentionDays ?? DEFAULT_RETENTION_DAYS);
  const batchSize = options.batchSize ?? DEFAULT_PRUNE_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_PRUNE_BATCHES;
  const blockedReportLimit = options.blockedReportLimit ?? DEFAULT_BLOCKED_REPORT_LIMIT;
  assertPositiveInteger(batchSize, "batchSize", MAX_BATCH_SIZE);
  assertPositiveInteger(maxBatches, "maxBatches");
  assertPositiveInteger(blockedReportLimit, "blockedReportLimit");
  return { retentionDays, batchSize, maxBatches, blockedReportLimit };
}

function nowMs(now?: () => number | Date): number {
  const value = now ? now() : Date.now();
  return typeof value === "number" ? value : value.getTime();
}

/**
 * Delete raw samples older than the retention period whose day has been summarised, oldest
 * first, in batches. Daily summaries are never touched. Errors from the database propagate.
 */
export async function pruneRateSamples(
  db: Queryable,
  options: RatePruningOptions = {},
): Promise<RatePruningResult> {
  const { retentionDays, batchSize, maxBatches, blockedReportLimit } = resolveOptions(options);
  const logger = options.logger ?? silentLogger;
  const at = nowMs(options.now);
  const day = utcDayString(at);
  const cutoff = calculateRetentionCutoff(retentionDays, at).toISOString();

  let rowsDeleted = 0;
  let batches = 0;
  let complete = false;
  while (batches < maxBatches) {
    const res = await db.query<{ deleted: number | string }>(PRUNE_RATE_SAMPLES_SQL, [
      cutoff,
      batchSize,
    ]);
    const deleted = Number(res.rows[0]?.deleted ?? 0);
    rowsDeleted += deleted;
    batches++;
    if (deleted < batchSize) {
      complete = true;
      break;
    }
  }

  const blockedRes = await db.query<BlockedRow>(SELECT_UNSUMMARIZED_DAYS_SQL, [
    cutoff,
    blockedReportLimit,
  ]);
  const blocked = blockedRes.rows.map((r) => ({
    network: r.network,
    sellAsset: r.sell_asset,
    buyAsset: r.buy_asset,
    source: r.source,
    anchorDomain: r.anchor_domain,
    day: r.day,
    samples: Number(r.samples),
  }));

  if (blocked.length > 0) {
    logger.log("warn", "corridor.rate_pruning.unsummarized_days_skipped", {
      message: `kept raw samples past the retention cutoff for ${blocked.length} series-days with no up-to-date daily summary`,
      cutoff,
      blocked,
      truncated: blocked.length === blockedReportLimit,
    });
  }
  if (!complete) {
    logger.log("warn", "corridor.rate_pruning.batch_limit_reached", {
      message: `stopped after ${batches} batches with rows still eligible; the next run continues`,
      rowsDeleted,
      batches,
      cutoff,
    });
  }
  logger.log("info", "corridor.rate_pruning.completed", {
    rowsDeleted,
    batches,
    complete,
    cutoff,
    retentionDays,
    day,
  });

  return { day, cutoff, retentionDays, rowsDeleted, batches, complete, blocked };
}

export interface RatePruningStepOptions extends RatePruningOptions {
  /** Step name in the loop's logs and results. Default "rate_pruning". */
  readonly name?: string;
}

/**
 * A `RateCollectorLoop` step that prunes once per UTC day. The first tick of a day runs
 * `pruneRateSamples`; later ticks that day return `{ skipped: true }` without touching the
 * database. A run that fails, or stops at `maxBatches` with rows left, is retried on the next
 * tick. A restart prunes again on its first tick, which deletes only what is still eligible.
 * The options are checked here, so a bad retention fails at startup, not on the first tick.
 */
export function createPruningCollectorStep(
  db: Queryable,
  options: RatePruningStepOptions = {},
): CollectorStep {
  resolveOptions(options);
  const name = options.name ?? "rate_pruning";
  let prunedDay: string | null = null;

  return {
    name,
    run: async (): Promise<CollectorStepResult> => {
      const day = utcDayString(nowMs(options.now));
      if (prunedDay === day) {
        return { skipped: true, day, message: `already pruned for ${day}` };
      }
      const result = await pruneRateSamples(db, options);
      if (result.complete) prunedDay = day;
      return {
        pruned: result.rowsDeleted,
        batches: result.batches,
        complete: result.complete,
        cutoff: result.cutoff,
        blocked: result.blocked.length,
        message: `pruned ${result.rowsDeleted} raw samples before ${result.cutoff}${
          result.complete ? "" : " (more remain; continuing next tick)"
        }${result.blocked.length > 0 ? `; kept ${result.blocked.length} unsummarised series-days` : ""}`,
      };
    },
  };
}
