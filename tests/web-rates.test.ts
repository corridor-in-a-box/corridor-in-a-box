import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { RateSummary } from "../web/lib/rate-summaries";
import {
  bandSegmentsToSvgPath,
  buildRateHistory,
  buildSeriesSegments,
  corridorPair,
  isReferenceSource,
  minimumDataStatus,
  pairMatches,
  segmentsToSvgPath,
} from "../web/lib/rates";

// Every summary here is built in the test; nothing is fetched.
const summary = (
  pair: string,
  date: string,
  source: string,
  sampleCount: number,
  median = "1585.5",
  p25 = "1580.25",
): RateSummary => ({
  pair,
  date,
  source,
  sampleCount,
  min: p25,
  p25,
  median,
  p75: median,
  max: median,
});

const NOW = new Date("2026-11-26T12:00:00Z");

/** One summary per day for `days` days ending on `lastDate`, each with `perDay` samples. */
const daily = (source: string, lastDate: string, days: number, perDay: number) =>
  Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.parse(`${lastDate}T00:00:00Z`) - (days - 1 - i) * 86_400_000);
    return summary("USDC/NGN", d.toISOString().slice(0, 10), source, perDay);
  });

describe("web rate history from daily summaries", () => {
  it("returns no pairs when there are no summaries, so the chart shows its empty state", () => {
    expect(buildRateHistory([], { now: NOW })).toEqual([]);
  });

  it("drops a pair whose summaries hold no samples instead of charting it", () => {
    const history = buildRateHistory([summary("USDC/KES", "2026-11-25", "dex", 0)], {
      now: NOW,
    });
    expect(history).toEqual([]);
  });

  it("groups by pair and source and keeps the published strings", () => {
    const history = buildRateHistory(
      [
        summary("USDC/NGN", "2026-11-24", "sep38:anchor.example", 96, "1590.1", "1588"),
        summary("USDC/NGN", "2026-11-25", "sep38:anchor.example", 96, "1591.2", "1589"),
        summary("USDC/NGN", "2026-11-25", "dex", 40, "1592", "1590"),
        summary("USDC/KES", "2026-11-25", "own_payment", 12, "129.4", "129"),
      ],
      { now: NOW },
    );
    expect(history.map((h) => h.pair)).toEqual(["USDC/KES", "USDC/NGN"]);
    const ngn = history[1];
    expect(ngn.dates).toEqual(["2026-11-24", "2026-11-25"]);
    expect(ngn.series.map((s) => s.source)).toEqual(["dex", "sep38:anchor.example"]);
    const anchor = ngn.series[1];
    expect(anchor.points.map((p) => p?.median)).toEqual(["1590.1", "1591.2"]);
    expect(anchor.points.map((p) => p?.p25)).toEqual(["1588", "1589"]);
  });

  it("marks a missing day and a zero-sample day as gaps rather than filling them", () => {
    const history = buildRateHistory(
      [
        summary("USDC/NGN", "2026-11-20", "dex", 50),
        summary("USDC/NGN", "2026-11-21", "dex", 0),
        // 2026-11-22 has no summary at all
        summary("USDC/NGN", "2026-11-23", "dex", 50),
      ],
      { now: NOW },
    );
    const [ngn] = history;
    expect(ngn.dates).toEqual(["2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23"]);
    expect(ngn.series[0].points.map((p) => p !== null)).toEqual([true, false, false, true]);
  });

  it("shows at most the last 30 days of a long history", () => {
    const history = buildRateHistory(daily("dex", "2026-11-25", 45, 96), { now: NOW });
    expect(history[0].dates).toHaveLength(30);
    expect(history[0].dates[0]).toBe("2026-10-27");
    expect(history[0].dates[29]).toBe("2026-11-25");
  });

  it("draws only the reference FX source as the reference line, with no eligibility", () => {
    expect(isReferenceSource("reference_fx")).toBe(true);
    expect(isReferenceSource("reference_fx:provider")).toBe(true);
    expect(isReferenceSource("sep38:reference_fx.example")).toBe(false);
    expect(isReferenceSource("dex")).toBe(false);

    const [ngn] = buildRateHistory(
      [
        summary("USDC/NGN", "2026-11-25", "reference_fx", 96),
        summary("USDC/NGN", "2026-11-25", "dex", 96),
      ],
      { now: NOW },
    );
    const ref = ngn.series.find((s) => s.source === "reference_fx");
    expect(ref?.kind).toBe("reference");
    expect(ref?.minimumData).toBeUndefined();
    expect(ngn.series.find((s) => s.source === "dex")?.kind).toBe("anchor");
  });

  it("matches a corridor's assets to a summary pair", () => {
    expect(corridorPair("USDC", "iso4217:NGN")).toBe("USDC/NGN");
    expect(pairMatches("USDC/NGN", "USDC/NGN")).toBe(true);
    expect(pairMatches("usdc/iso4217:ngn", "USDC/NGN")).toBe(true);
    expect(pairMatches("USDC/KES", "USDC/NGN")).toBe(false);
  });
});

describe("RFC 0004 minimum-data rule from daily summaries", () => {
  it("meets the rule with 7 days of data and at least 100 samples in the last 7 days", () => {
    const status = minimumDataStatus(daily("sep38:a.example", "2026-11-26", 7, 15), NOW);
    expect(status).toEqual({
      daysWithData: 7,
      samplesInWindow: 105,
      windowStart: "2026-11-20",
      windowEnd: "2026-11-26",
      meetsRule: true,
    });
  });

  it("is below the rule with fewer than 7 days of data, however many samples", () => {
    const status = minimumDataStatus(daily("sep38:a.example", "2026-11-26", 6, 500), NOW);
    expect(status.daysWithData).toBe(6);
    expect(status.meetsRule).toBe(false);
  });

  it("is below the rule with fewer than 100 samples in the window", () => {
    const status = minimumDataStatus(daily("sep38:a.example", "2026-11-26", 10, 14), NOW);
    expect(status.daysWithData).toBe(10);
    expect(status.samplesInWindow).toBe(98);
    expect(status.meetsRule).toBe(false);
  });

  it("does not count stale history toward the window", () => {
    const status = minimumDataStatus(daily("sep38:a.example", "2026-11-01", 20, 96), NOW);
    expect(status.daysWithData).toBe(20);
    expect(status.samplesInWindow).toBe(0);
    expect(status.meetsRule).toBe(false);
  });

  it("ignores zero-sample days and days after today", () => {
    const status = minimumDataStatus(
      [
        ...daily("sep38:a.example", "2026-11-25", 6, 96),
        summary("USDC/NGN", "2026-11-26", "sep38:a.example", 0),
        summary("USDC/NGN", "2026-11-27", "sep38:a.example", 96),
      ],
      NOW,
    );
    expect(status.daysWithData).toBe(6);
    expect(status.meetsRule).toBe(false);
  });

  it("attaches the computed status to each anchor series", () => {
    const [ngn] = buildRateHistory(
      [...daily("sep38:a.example", "2026-11-26", 8, 96), ...daily("dex", "2026-11-26", 3, 96)],
      { now: NOW },
    );
    expect(
      ngn.series.find((s) => s.source === "sep38:a.example")?.minimumData?.meetsRule,
    ).toBe(true);
    expect(ngn.series.find((s) => s.source === "dex")?.minimumData?.meetsRule).toBe(false);
  });
});

describe("chart paths break at gaps", () => {
  const dates = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"];
  const points = [
    summary("USDC/USD", dates[0], "dex", 10, "1.01", "1.00"),
    summary("USDC/USD", dates[1], "dex", 10, "1.02", "1.01"),
    null,
    summary("USDC/USD", dates[3], "dex", 10, "1.015", "1.01"),
    summary("USDC/USD", dates[4], "dex", 10, "1.018", "1.01"),
  ];
  const mapX = (i: number) => i * 100;
  const mapY = (r: number) => 500 - r * 100;

  it("splits a series into separate segments around a gap", () => {
    const segments = buildSeriesSegments(dates, points, (s) => s.median, mapX, mapY);
    expect(segments).toHaveLength(2);
    expect(segments[0].points.map((p) => p.date)).toEqual(["2026-11-01", "2026-11-02"]);
    expect(segments[1].points.map((p) => p.date)).toEqual(["2026-11-04", "2026-11-05"]);
    expect(segments[0].points[0].value).toBe("1.01");

    const path = segmentsToSvgPath(segments);
    expect(path.match(/M /g)).toHaveLength(2);
    expect(path).toContain("M 0.00");
    expect(path).toContain("M 300.00");
    expect(path).not.toContain(" 200.00 "); // the gap day's x never appears
  });

  it("closes one band per segment, so shading also stops at the gap", () => {
    const band = bandSegmentsToSvgPath(dates, points, mapX, mapY);
    expect(band.match(/M /g)).toHaveLength(2);
    expect(band.match(/Z/g)).toHaveLength(2);
    expect(band).not.toContain("200.00 ");
  });

  it("returns an empty path when there is nothing to draw", () => {
    expect(segmentsToSvgPath([])).toBe("");
    expect(bandSegmentsToSvgPath(["2026-11-01"], [null], mapX, mapY)).toBe("");
  });
});

describe("rate history chart source", () => {
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

  it("has no generated rates, invented anchors or hardcoded eligibility", () => {
    for (const path of ["web/lib/rates.ts", "web/components/RateHistoryChart.tsx"]) {
      const source = read(path);
      expect(source).not.toMatch(/seededRandom|Math\.random/);
      expect(source).not.toMatch(/estimatedEligible/);
      expect(source).not.toMatch(/mock-anchor|testanchor\.stellar\.org/);
    }
  });

  it("does not fetch on its own; pages pass in what fetchRateSummaries read", () => {
    expect(read("web/components/RateHistoryChart.tsx")).not.toMatch(/fetch\(/);
    for (const page of ["web/app/page.tsx", "web/app/corridors/[id]/page.tsx"]) {
      expect(read(page)).toMatch(/fetchRateSummaries\(\)/);
    }
  });
});
