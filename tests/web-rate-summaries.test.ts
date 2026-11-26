import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchRateSummaries,
  latestRateSummaries,
  type RateSummary,
} from "../web/lib/rate-summaries";

afterEach(() => {
  vi.unstubAllGlobals();
});

const summary = (
  pair: string,
  date: string,
  source: string,
  sampleCount: number,
): RateSummary => ({
  pair,
  date,
  source,
  sampleCount,
  min: "101.5",
  p25: "102.25",
  median: "103",
  p75: "104.75",
  max: "105.5",
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("web rate summaries", () => {
  it("does not call an upstream source when none is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchRateSummaries("  ");

    expect(result).toMatchObject({ ok: false, configured: false, error: "not_configured" });
    expect(result.summaries).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches, validates and sorts published summaries", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse([
        summary("USDC/NGN", "2026-11-22", "dex", 420),
        summary("USDC/NGN", "2026-11-23", "sep38:anchor.example", 1912),
        summary("USDC/KES", "2026-11-23", "own_payment", 310),
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchRateSummaries("https://rates.example/daily.json");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://rates.example/daily.json",
      expect.objectContaining({ cache: "force-cache" }),
    );
    expect(result.ok).toBe(true);
    expect(result.summaries.map((entry) => [entry.pair, entry.date])).toEqual([
      ["USDC/KES", "2026-11-23"],
      ["USDC/NGN", "2026-11-23"],
      ["USDC/NGN", "2026-11-22"],
    ]);
  });

  it("keeps the newest summary per pair and source", async () => {
    const newest = summary("USDC/NGN", "2026-11-23", "dex", 500);
    const rows = latestRateSummaries([
      summary("USDC/NGN", "2026-11-22", "dex", 420),
      newest,
      summary("USDC/KES", "2026-11-23", "own_payment", 310),
    ]);

    expect(rows.map((row) => [row.pair, row.source, row.sampleCount])).toEqual([
      ["USDC/KES", "own_payment", 310],
      ["USDC/NGN", "dex", 500],
    ]);
  });

  it("reports upstream and payload failures without inventing values", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 503));
    vi.stubGlobal("fetch", fetchMock);

    const unavailable = await fetchRateSummaries("https://rates.example/daily.json");
    expect(unavailable).toMatchObject({ ok: false, error: "upstream_unavailable" });
    expect(unavailable.summaries).toEqual([]);

    fetchMock.mockImplementation(async () => jsonResponse({ summaries: "not an array" }));
    const invalid = await fetchRateSummaries("https://rates.example/daily.json");
    expect(invalid).toMatchObject({ ok: false, error: "invalid_payload" });
    expect(invalid.summaries).toEqual([]);
  });
});
