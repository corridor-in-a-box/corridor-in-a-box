// Durable rate history backed by SQL (Postgres). RFC 0004 §3, issue #589.
//
// Rate samples record prices observed over time from four sources: an anchor's
// SEP-38 indicative price, a Stellar DEX trade, a public reference FX rate, and
// the effective rate of the business's own completed payments. The collectors
// write here; the planner reads a window back to build `estimated` prices.
//
// Rates are stored as Postgres `numeric` and travel through this module as
// decimal strings. They are never parsed into a JS number, so no float rounding
// can creep in between the anchor's response and the stored value.
//
// Same tiny Queryable seam as idempotency-pg.ts; the table is created by the
// shared, idempotent `migrate()` there.

import type { Queryable } from "./idempotency-pg";

/** Where a sample came from. Mirrors the `source` check constraint below. */
export const RATE_SAMPLE_SOURCES = [
  "sep38_price",
  "dex_trade",
  "reference_fx",
  "own_payment",
] as const;
export type RateSampleSource = (typeof RATE_SAMPLE_SOURCES)[number];

export const CREATE_RATE_SAMPLES_TABLE_SQL = `
create table if not exists rate_samples (
  id            bigserial primary key,
  sell_asset    text not null,
  buy_asset     text not null,
  source        text not null
                check (source in ('sep38_price', 'dex_trade', 'reference_fx', 'own_payment')),
  anchor_domain text,
  rate          numeric not null check (rate > 0),
  sampled_at    timestamptz not null,
  network       text not null,
  run_id        text,
  detail        jsonb,
  recorded_at   timestamptz not null default now()
);`;

/**
 * Window queries read one pair on one network over a time range, newest first, so the index
 * leads with the pair and network and ends with `sampled_at`.
 */
export const RATE_SAMPLES_INDEX_SQL = [
  `create index if not exists rate_samples_pair_network_sampled_at_idx on rate_samples (sell_asset, buy_asset, network, sampled_at desc);`,
];

/** One sample to store. Assets are SEP-38 strings, e.g. `stellar:USDC:G...` or `iso4217:NGN`. */
export interface RateSampleInput {
  sellAsset: string;
  buyAsset: string;
  source: RateSampleSource;
  /** The anchor the price came from; null for DEX trades and reference FX. */
  anchorDomain?: string | null;
  /** Units of `buyAsset` per one unit of `sellAsset`, as a positive decimal string. */
  rate: string;
  /** When the price was observed: epoch milliseconds, a Date, or an ISO timestamp. */
  sampledAt: number | Date | string;
  /** `testnet` or `public`. */
  network: string;
  /** The payment run this sample came from, for `own_payment` samples. */
  runId?: string | null;
  detail?: Record<string, unknown> | null;
}

/** A stored sample, as `list()` returns it. `sampledAt` is epoch milliseconds. */
export interface RateSampleRecord extends Omit<RateSampleInput, "sampledAt"> {
  id: string;
  anchorDomain: string | null;
  sampledAt: number;
  runId: string | null;
  detail: Record<string, unknown> | null;
}

export interface ListRateSamplesFilter {
  sellAsset?: string;
  buyAsset?: string;
  source?: RateSampleSource;
  anchorDomain?: string;
  network?: string;
  /** Inclusive lower bound on `sampled_at`. */
  since?: number | Date | string;
  /** Inclusive upper bound on `sampled_at`. */
  until?: number | Date | string;
  /** At most this many rows (1 to 10,000). Unset returns every match. */
  limit?: number;
}

interface Row {
  id: string | number;
  sell_asset: string;
  buy_asset: string;
  source: RateSampleSource;
  anchor_domain: string | null;
  rate: string;
  sampled_at: Date | string;
  network: string;
  run_id: string | null;
  detail: Record<string, unknown> | null;
}

const DECIMAL = /^\d+(?:\.\d+)?$/;
const MAX_LIMIT = 10_000;

function toDate(value: number | Date | string, field: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new RangeError(`${field} is not a valid time: ${String(value)}`);
  return date;
}

/** Rejects anything that is not a positive plain decimal string, before it reaches SQL. */
export function assertRateSample(sample: RateSampleInput): void {
  if (!RATE_SAMPLE_SOURCES.includes(sample.source)) {
    throw new RangeError(`unknown rate sample source: ${String(sample.source)}`);
  }
  if (
    typeof sample.rate !== "string" ||
    !DECIMAL.test(sample.rate) ||
    !/[1-9]/.test(sample.rate)
  ) {
    throw new RangeError(
      `rate must be a positive decimal string, got ${JSON.stringify(sample.rate)}`,
    );
  }
  if (!sample.sellAsset || !sample.buyAsset)
    throw new RangeError("sellAsset and buyAsset are required");
  if (!sample.network) throw new RangeError("network is required");
  toDate(sample.sampledAt, "sampledAt");
}

export class PostgresRateHistoryStore {
  constructor(private readonly db: Queryable) {}

  /** Insert one sample. Throws RangeError on an invalid rate, source or time. */
  async record(sample: RateSampleInput): Promise<void> {
    assertRateSample(sample);
    await this.db.query(
      `insert into rate_samples (
        sell_asset, buy_asset, source, anchor_domain, rate, sampled_at, network, run_id, detail
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        sample.sellAsset,
        sample.buyAsset,
        sample.source,
        sample.anchorDomain ?? null,
        sample.rate,
        toDate(sample.sampledAt, "sampledAt").toISOString(),
        sample.network,
        sample.runId ?? null,
        sample.detail ? JSON.stringify(sample.detail) : null,
      ],
    );
  }

  /** Samples matching `filter`, newest first. */
  async list(filter: ListRateSamplesFilter = {}): Promise<RateSampleRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const where = (column: string, op: string, value: unknown) => {
      params.push(value);
      clauses.push(`${column} ${op} $${params.length}`);
    };

    if (filter.sellAsset) where("sell_asset", "=", filter.sellAsset);
    if (filter.buyAsset) where("buy_asset", "=", filter.buyAsset);
    if (filter.source) where("source", "=", filter.source);
    if (filter.anchorDomain) where("anchor_domain", "=", filter.anchorDomain);
    if (filter.network) where("network", "=", filter.network);
    if (filter.since !== undefined)
      where("sampled_at", ">=", toDate(filter.since, "since").toISOString());
    if (filter.until !== undefined)
      where("sampled_at", "<=", toDate(filter.until, "until").toISOString());

    let limit = "";
    if (filter.limit !== undefined) {
      if (!Number.isInteger(filter.limit) || filter.limit < 1) {
        throw new RangeError("limit must be a positive integer");
      }
      limit = `limit ${Math.min(filter.limit, MAX_LIMIT)}`;
    }

    const res = await this.db.query<Row>(
      `select id, sell_asset, buy_asset, source, anchor_domain, rate::text as rate, sampled_at,
              network, run_id, detail
       from rate_samples
       ${clauses.length ? `where ${clauses.join(" and ")}` : ""}
       order by sampled_at desc, id desc
       ${limit}`,
      params,
    );

    return res.rows.map((r) => ({
      id: String(r.id),
      sellAsset: r.sell_asset,
      buyAsset: r.buy_asset,
      source: r.source,
      anchorDomain: r.anchor_domain,
      rate: r.rate,
      sampledAt: (r.sampled_at instanceof Date
        ? r.sampled_at
        : new Date(r.sampled_at)
      ).getTime(),
      network: r.network,
      runId: r.run_id,
      detail: r.detail,
    }));
  }
}
