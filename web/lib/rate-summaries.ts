export const RATE_SUMMARY_REVALIDATE_SECONDS = 3600;

export interface RateSummary {
  pair: string;
  date: string;
  source: string;
  sampleCount: number;
  min: string;
  p25: string;
  median: string;
  p75: string;
  max: string;
}

export type RateSummaryError =
  | "not_configured"
  | "invalid_url"
  | "upstream_unavailable"
  | "invalid_payload";

export interface RateSummarySnapshot {
  ok: boolean;
  configured: boolean;
  error?: RateSummaryError;
  summaries: RateSummary[];
  readAt: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isValidDate = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const parseRate = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return /^\d+(?:\.\d+)?$/.test(trimmed) ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return String(value);
  return undefined;
};

const parseSummary = (value: unknown): RateSummary | undefined => {
  if (!isRecord(value)) return undefined;
  if (typeof value.pair !== "string" || !value.pair.trim()) return undefined;
  if (!isValidDate(value.date)) return undefined;
  if (typeof value.source !== "string" || !value.source.trim()) return undefined;
  if (
    typeof value.sampleCount !== "number" ||
    !Number.isInteger(value.sampleCount) ||
    value.sampleCount < 0
  ) {
    return undefined;
  }

  const min = parseRate(value.min);
  const p25 = parseRate(value.p25);
  const median = parseRate(value.median);
  const p75 = parseRate(value.p75);
  const max = parseRate(value.max);
  if (
    min === undefined ||
    p25 === undefined ||
    median === undefined ||
    p75 === undefined ||
    max === undefined
  ) {
    return undefined;
  }

  return {
    pair: value.pair.trim(),
    date: value.date,
    source: value.source.trim(),
    sampleCount: value.sampleCount,
    min,
    p25,
    median,
    p75,
    max,
  };
};

const parseSummaries = (value: unknown): RateSummary[] | undefined => {
  const raw = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.summaries)
      ? value.summaries
      : undefined;
  if (!raw) return undefined;

  const summaries: RateSummary[] = [];
  for (const item of raw) {
    const summary = parseSummary(item);
    if (!summary) return undefined;
    summaries.push(summary);
  }
  return summaries;
};

const sortSummaries = (summaries: readonly RateSummary[]) =>
  [...summaries].sort(
    (a, b) =>
      a.pair.localeCompare(b.pair) ||
      b.date.localeCompare(a.date) ||
      a.source.localeCompare(b.source),
  );

export function latestRateSummaries(summaries: readonly RateSummary[]): RateSummary[] {
  const latest = new Map<string, RateSummary>();
  for (const summary of summaries) {
    const key = `${summary.pair}\u0000${summary.source}`;
    const previous = latest.get(key);
    if (!previous || summary.date > previous.date) latest.set(key, summary);
  }
  return sortSummaries([...latest.values()]);
}

export async function fetchRateSummaries(
  configuredUrl: string | undefined = process.env.RATE_SUMMARIES_URL,
): Promise<RateSummarySnapshot> {
  const readAt = new Date().toISOString();
  const failed = (
    error: RateSummaryError,
    configured: boolean,
  ): RateSummarySnapshot => ({ ok: false, configured, error, summaries: [], readAt });

  if (!configuredUrl?.trim()) return failed("not_configured", false);

  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch {
    return failed("invalid_url", true);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return failed("invalid_url", true);
  }

  try {
    const init = {
      cache: "force-cache",
      next: { revalidate: RATE_SUMMARY_REVALIDATE_SECONDS },
    } as Parameters<typeof fetch>[1];
    const response = await fetch(url.toString(), init);
    if (!response.ok) return failed("upstream_unavailable", true);

    const summaries = parseSummaries(await response.json());
    if (!summaries) return failed("invalid_payload", true);

    return { ok: true, configured: true, summaries: sortSummaries(summaries), readAt };
  } catch {
    return failed("upstream_unavailable", true);
  }
}
