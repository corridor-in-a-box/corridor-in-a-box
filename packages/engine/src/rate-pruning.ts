// Rate history: retention and pruning (#599, RFC 0004 §3).
//
// Raw rate samples collected every 15 minutes grow quickly. Daily summaries (rate_daily)
// are retained forever, while raw samples older than the retention period (default 90 days)
// are pruned once per day inside the collector loop in bounded batches.
//
// Strict Guard: A raw sample is NEVER deleted unless a matching daily summary row
// exists in rate_daily for the exact same pair, source, network and UTC calendar day.
// This invariant is enforced directly in the deletion query so no race condition can bypass it.

import type { Queryable } from "./idempotency-pg";
import { silentLogger, type Logger } from "./observability";

/** Default retention period for raw rate samples in days (RFC 0004 §3 / Issue #599). */
export const DEFAULT_RETENTION_DAYS = 90;

/** Default batch size for iterative deletions to avoid table lock contention. */
export const DEFAULT_PRUNE_BATCH_SIZE = 1000;

/** Maximum batches allowed per pruning run to bound execution time. */
export const DEFAULT_MAX_PRUNE_BATCHES = 100;

/**
 * Validates and parses the raw rate sample retention period in days.
 * Rejects zero, negative values, floats, and non-numeric strings with a clear Error.
 */
export function parseRetentionDays(
  val?: string | number | null,
  fallback: number = DEFAULT_RETENTION_DAYS,
): number {
  if (val === undefined || val === null || val === "") {
    return fallback;
  }

  let parsedNum: number;
  if (typeof val === "number") {
    parsedNum = val;
  } else {
    const trimmed = String(val).trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new Error(
        `Invalid retention period: "${val}". Must be a positive integer (number of days).`,
      );
    }
    parsedNum = Number(trimmed);
  }

  if (!Number.isInteger(parsedNum) || parsedNum <= 0 || !Number.isFinite(parsedNum)) {
    throw new Error(
      `Invalid retention period: "${val}". Must be a positive integer (number of days).`,
    );
  }

  return parsedNum;
}

/**
 * Returns the calendar day formatted as "YYYY-MM-DD" in UTC timezone.
 */
export function utcDayString(dateOrMs: Date | number = Date.now()): string {
  const d = typeof dateOrMs === "number" ? new Date(dateOrMs) : dateOrMs;
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Calculates the exact cutoff timestamp for retentionDays prior to `now`.
 * Any sample strictly older than this cutoff (sampled_at < cutoff) is eligible for pruning.
 */
export function calculateRetentionCutoff(
  retentionDays: number,
  nowOrMs: Date | number = Date.now(),
): Date {
  const nowMs = typeof nowOrMs === "number" ? nowOrMs : nowOrMs.getTime();
  return new Date(nowMs - retentionDays * 86_400_000);
}

/**
 * Batched deletion query enforcing the summary guard in SQL.
 * Deletes oldest samples first up to $2 limit, ONLY if a daily summary exists for that
 * exact (pair, source, network, UTC day).
 */
export const DELETE_PRUNABLE_SAMPLES_SQL = `
delete from rate_samples
where id in (
  select s.id
  from rate_samples s
  where s.sampled_at < $1
    and exists (
      select 1
      from rate_daily d
      where d.day = (s.sampled_at at time zone 'UTC')::date
        and d.pair = s.pair
        and d.source = s.source
        and d.network = s.network
    )
  order by s.sampled_at asc
  limit $2
)
returning id;
`;

/**
 * Checks for any raw samples older than cutoff that lack a matching daily summary
 * for the same pair, source, network and UTC day.
 */
export const SELECT_UNSUMMARIZED_DAYS_SQL = `
select distinct
  (s.sampled_at at time zone 'UTC')::date as unsummarized_day,
  s.pair,
  s.source,
  s.network
from rate_samples s
where s.sampled_at < $1
  and not exists (
    select 1
    from rate_daily d
    where d.day = (s.sampled_at at time zone 'UTC')::date
      and d.pair = s.pair
      and d.source = s.source
      and d.network = s.network
  )
order by unsummarized_day asc;
`;

/** Reads durable pruning state to survive process restarts without duplicate pruning. */
export const SELECT_PRUNING_STATE_SQL = `
select last_pruned_day, last_pruned_at, rows_deleted, batches
from rate_pruning_state
where key = $1;
`;

/** Upserts durable pruning state after a successful daily run. */
export const UPSERT_PRUNING_STATE_SQL = `
insert into rate_pruning_state (key, last_pruned_day, last_pruned_at, rows_deleted, batches)
values ($1, $2, $3, $4, $5)
on conflict (key) do update set
  last_pruned_day = excluded.last_pruned_day,
  last_pruned_at = excluded.last_pruned_at,
  rows_deleted = excluded.rows_deleted,
  batches = excluded.batches;
`;

export interface UnsummarizedDayRecord {
  readonly unsummarizedDay: string;
  readonly pair: string;
  readonly source: string;
  readonly network: string;
}

export interface RatePruningOptions {
  /** Retention period in days, or env string value (e.g. process.env.RATE_RETENTION_DAYS). Default 90. */
  readonly retentionDays?: number | string | null;
  /** Number of rows to delete per batch. Default 1000. */
  readonly batchSize?: number;
  /** Maximum batches allowed per pruning invocation. Default 100. */
  readonly maxBatches?: number;
  /** Clock provider for testing. Defaults to Date.now. */
  readonly now?: () => number | Date;
  /** Operational logger. Defaults to silentLogger. */
  readonly logger?: Logger;
  /** Key identifying this pruner in rate_pruning_state. Default "rate_samples_daily". */
  readonly stateKey?: string;
  /** Force execution even if already run today. Default false. */
  readonly force?: boolean;
}

export interface RatePruningResult {
  readonly status: "completed" | "skipped_already_run_today";
  readonly day: string;
  readonly cutoff: string;
  readonly rowsDeleted: number;
  readonly batches: number;
  readonly unsummarizedDaysSkipped: string[];
  readonly unsummarizedSkipped?: UnsummarizedDayRecord[];
}

/**
 * Executes rate sample pruning against the database with batching and strict summary guard.
 */
export async function pruneRateSamples(
  db: Queryable,
  options: RatePruningOptions = {},
): Promise<RatePruningResult> {
  const retentionDays = parseRetentionDays(
    options.retentionDays ??
      process.env.RATE_RETENTION_DAYS ??
      process.env.RATE_SAMPLE_RETENTION_DAYS,
  );
  const batchSize = options.batchSize ?? DEFAULT_PRUNE_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_PRUNE_BATCHES;
  const logger = options.logger ?? silentLogger;
  const stateKey = options.stateKey ?? "rate_samples_daily";

  const nowVal = options.now ? options.now() : Date.now();
  const nowMs = typeof nowVal === "number" ? nowVal : nowVal.getTime();
  const todayUtc = utcDayString(nowMs);
  const cutoffDate = calculateRetentionCutoff(retentionDays, nowMs);

  // 1. Check if already pruned today (survives restarts)
  if (!options.force) {
    try {
      const stateRes = await db.query<{ last_pruned_day: string }>(SELECT_PRUNING_STATE_SQL, [
        stateKey,
      ]);
      if (stateRes.rows.length > 0 && stateRes.rows[0].last_pruned_day === todayUtc) {
        logger.log("debug", "corridor.rate_pruning.skipped_already_run_today", {
          message: "Pruning already completed for UTC day; skipping run",
          day: todayUtc,
        });
        return {
          status: "skipped_already_run_today",
          day: todayUtc,
          cutoff: cutoffDate.toISOString(),
          rowsDeleted: 0,
          batches: 0,
          unsummarizedDaysSkipped: [],
          unsummarizedSkipped: [],
        };
      }
    } catch {
      // Table may not yet exist in unmigrated test harness; continue
    }
  }

  // 2. Identify unsummarized records older than cutoff to make missing summaries visible
  let unsummarizedDaysSkipped: string[] = [];
  let unsummarizedSkipped: UnsummarizedDayRecord[] = [];

  try {
    const unsummarizedRes = await db.query<{
      unsummarized_day: string | Date;
      pair: string;
      source: string;
      network: string;
    }>(SELECT_UNSUMMARIZED_DAYS_SQL, [cutoffDate]);

    unsummarizedSkipped = unsummarizedRes.rows.map((r) => {
      const dayStr =
        r.unsummarized_day instanceof Date
          ? utcDayString(r.unsummarized_day)
          : String(r.unsummarized_day).slice(0, 10);
      return {
        unsummarizedDay: dayStr,
        pair: r.pair,
        source: r.source,
        network: r.network,
      };
    });

    unsummarizedDaysSkipped = Array.from(
      new Set(unsummarizedSkipped.map((r) => r.unsummarizedDay)),
    );

    if (unsummarizedSkipped.length > 0) {
      logger.log("warn", "corridor.rate_pruning.unsummarized_days_skipped", {
        message: `Skipped pruning raw rate samples for ${unsummarizedSkipped.length} series older than cutoff because no matching daily summary exists`,
        skipped: unsummarizedSkipped,
        skippedDays: unsummarizedDaysSkipped,
        cutoff: cutoffDate.toISOString(),
      });
    }
  } catch {
    // If SELECT query fails, proceed to attempt delete or throw
  }

  // 3. Batched deletion loop
  let rowsDeleted = 0;
  let batches = 0;

  while (batches < maxBatches) {
    const res = await db.query<{ id: string | number }>(DELETE_PRUNABLE_SAMPLES_SQL, [
      cutoffDate,
      batchSize,
    ]);
    const count = res.rows.length;
    rowsDeleted += count;
    batches++;

    if (count < batchSize) {
      // No further eligible rows remain
      break;
    }
  }

  // 4. Update durable state
  try {
    await db.query(UPSERT_PRUNING_STATE_SQL, [
      stateKey,
      todayUtc,
      new Date(nowMs),
      rowsDeleted,
      batches,
    ]);
  } catch {
    // If DB state table is missing, proceed
  }

  logger.log("info", "corridor.rate_pruning.completed", {
    message: `Pruned ${rowsDeleted} raw rate samples in ${batches} batch(es)`,
    rowsDeleted,
    batches,
    cutoff: cutoffDate.toISOString(),
    day: todayUtc,
  });

  return {
    status: "completed",
    day: todayUtc,
    cutoff: cutoffDate.toISOString(),
    rowsDeleted,
    batches,
    unsummarizedDaysSkipped,
    unsummarizedSkipped,
  };
}

export interface CollectorStepResult {
  readonly collected?: number;
  readonly message?: string;
  readonly [key: string]: unknown;
}

export type CollectorStepFn = () =>
  Promise<CollectorStepResult | void> | CollectorStepResult | void;

export interface CollectorStep {
  readonly name: string;
  readonly run: CollectorStepFn;
}

export interface RatePruningStepOptions extends RatePruningOptions {
  /** Optional custom step name. Default "rate_history_pruning". */
  readonly stepName?: string;
}

/**
 * Creates a CollectorStep suitable for registration with RateCollectorLoop.
 * Guarantees in-memory caching so the step executes at most once per UTC day,
 * without querying the database on every collector tick.
 */
export function createPruningCollectorStep(
  db: Queryable,
  options: RatePruningStepOptions = {},
): CollectorStep {
  let inMemoryLastDayUtc: string | null = null;
  const stepName = options.stepName ?? "rate_history_pruning";

  return {
    name: stepName,
    run: async (): Promise<CollectorStepResult> => {
      const nowVal = options.now ? options.now() : Date.now();
      const currentDayUtc = utcDayString(nowVal);

      // In-memory quick check avoids DB query on 95 out of 96 ticks in a 15-min schedule
      if (!options.force && inMemoryLastDayUtc === currentDayUtc) {
        return {
          skipped: true,
          reason: "already_run_today",
          day: currentDayUtc,
        };
      }

      const res = await pruneRateSamples(db, options);
      if (res.status === "completed" || res.status === "skipped_already_run_today") {
        inMemoryLastDayUtc = currentDayUtc;
      }

      return {
        ...res,
        collected: res.rowsDeleted,
      };
    },
  };
}
