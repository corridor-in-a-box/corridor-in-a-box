// Durable rate history backed by SQL (Postgres).
//
// Rate samples record effective prices observed over time from various sources
// (SEP-38 quotes, DEX trades, reference FX, and own completed payments) to enable
// rate comparison and estimation.
//
// Rates are strictly stored as arbitrary-precision NUMERIC or text, NEVER floats,
// to prevent floating-point rounding errors and precision loss.
//
// Same tiny Queryable seam as idempotency-pg.ts.

import type { Queryable } from "./idempotency-pg";

export const CREATE_RATE_SAMPLES_TABLE_SQL = `
create table if not exists rate_samples (
  id            bigserial primary key,
  pair          text not null,
  sell_asset    text not null,
  buy_asset     text not null,
  source        text not null,
  anchor_domain text,
  rate          numeric not null,
  sampled_at    timestamptz not null,
  network       text not null,
  run_id        text,
  detail        jsonb
);`;

export const RATE_SAMPLES_INDEX_SQL = [
  `create index if not exists rate_samples_pair_network_sampled_at_idx on rate_samples (pair, network, sampled_at desc);`,
  `create index if not exists rate_samples_assets_network_sampled_at_idx on rate_samples (sell_asset, buy_asset, network, sampled_at desc);`,
];

export type RateSampleSource = "sep38_price" | "dex_trade" | "reference_fx" | "own_payment";

export interface RateSampleRecord {
  id?: number | string;
  pair?: string;
  sellAsset: string;
  buyAsset: string;
  source: RateSampleSource | string;
  anchorDomain?: string | null;
  /** Rate stored as string representing exact decimal value, never a float. */
  rate: string;
  /** Epoch milliseconds, Date object, or ISO timestamp string. */
  sampledAt: number | Date | string;
  network: string;
  runId?: string | null;
  detail?: Record<string, unknown> | null;
}

export interface ListRateSamplesFilter {
  pair?: string;
  sellAsset?: string;
  buyAsset?: string;
  source?: string;
  anchorDomain?: string;
  network?: string;
  since?: number | Date | string;
  until?: number | Date | string;
  limit?: number;
}

interface Row {
  id: string | number;
  pair: string;
  sell_asset: string;
  buy_asset: string;
  source: string;
  anchor_domain: string | null;
  rate: string;
  sampled_at: Date | string;
  network: string;
  run_id: string | null;
  detail: Record<string, unknown> | null;
}

export class PostgresRateHistoryStore {
  constructor(private readonly db: Queryable) {}

  /**
   * Insert a rate sample record into rate_samples.
   */
  async record(sample: RateSampleRecord): Promise<void> {
    const pair = sample.pair ?? `${sample.sellAsset}:${sample.buyAsset}`;
    const sampledAt =
      sample.sampledAt instanceof Date
        ? sample.sampledAt
        : typeof sample.sampledAt === "number"
          ? new Date(sample.sampledAt)
          : new Date(sample.sampledAt);

    await this.db.query(
      `insert into rate_samples (
        pair, sell_asset, buy_asset, source, anchor_domain, rate, sampled_at, network, run_id, detail
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        pair,
        sample.sellAsset,
        sample.buyAsset,
        sample.source,
        sample.anchorDomain ?? null,
        sample.rate,
        sampledAt.toISOString(),
        sample.network,
        sample.runId ?? null,
        sample.detail ? JSON.stringify(sample.detail) : null,
      ],
    );
  }

  /**
   * Query rate samples matching filter criteria, ordered by sampled_at desc.
   */
  async list(filter: ListRateSamplesFilter = {}): Promise<RateSampleRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter.pair) {
      params.push(filter.pair);
      clauses.push(`pair = $${params.length}`);
    }
    if (filter.sellAsset) {
      params.push(filter.sellAsset);
      clauses.push(`sell_asset = $${params.length}`);
    }
    if (filter.buyAsset) {
      params.push(filter.buyAsset);
      clauses.push(`buy_asset = $${params.length}`);
    }
    if (filter.source) {
      params.push(filter.source);
      clauses.push(`source = $${params.length}`);
    }
    if (filter.anchorDomain) {
      params.push(filter.anchorDomain);
      clauses.push(`anchor_domain = $${params.length}`);
    }
    if (filter.network) {
      params.push(filter.network);
      clauses.push(`network = $${params.length}`);
    }
    if (filter.since) {
      const sinceDate =
        filter.since instanceof Date
          ? filter.since
          : typeof filter.since === "number"
            ? new Date(filter.since)
            : new Date(filter.since);
      params.push(sinceDate.toISOString());
      clauses.push(`sampled_at >= $${params.length}`);
    }
    if (filter.until) {
      const untilDate =
        filter.until instanceof Date
          ? filter.until
          : typeof filter.until === "number"
            ? new Date(filter.until)
            : new Date(filter.until);
      params.push(untilDate.toISOString());
      clauses.push(`sampled_at <= $${params.length}`);
    }

    const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
    const limit = filter.limit ? `limit ${Math.max(1, Math.min(filter.limit, 1000))}` : "";

    const res = await this.db.query<Row>(
      `select id, pair, sell_asset, buy_asset, source, anchor_domain, rate::text, sampled_at, network, run_id, detail
       from rate_samples
       ${where}
       order by sampled_at desc
       ${limit}`,
      params,
    );

    return res.rows.map((r) => ({
      id: r.id,
      pair: r.pair,
      sellAsset: r.sell_asset,
      buyAsset: r.buy_asset,
      source: r.source,
      anchorDomain: r.anchor_domain,
      rate: r.rate,
      sampledAt:
        r.sampled_at instanceof Date
          ? r.sampled_at.getTime()
          : new Date(r.sampled_at).getTime(),
      network: r.network,
      runId: r.run_id,
      detail: r.detail,
    }));
  }
}
