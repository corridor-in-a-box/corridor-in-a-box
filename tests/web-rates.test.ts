import { describe, expect, it } from "vitest";
import {
  getDailySummaryData,
  buildAnchorSegments,
  segmentsToSvgPath,
  type DailyRatePoint,
} from "../web/lib/rates";
import { GET as getDailySummaryRoute } from "../web/app/api/rates/daily-summary/route";

describe("web rate history & daily summary", () => {
  it("generates 30-day rate history for all expected currency pairs", () => {
    const data = getDailySummaryData();
    expect(data.pairs.length).toBeGreaterThanOrEqual(4);

    const usdPair = data.pairs.find((p) => p.pair === "USDC/iso4217:USD");
    expect(usdPair).toBeDefined();
    expect(usdPair?.displayPair).toBe("USDC/USD");
    expect(usdPair?.anchors).toContain("testanchor.stellar.org");
    expect(usdPair?.anchors).toContain("mock-anchor.stellar.org");
    expect(usdPair?.points).toHaveLength(30);

    const ngnPair = data.pairs.find((p) => p.pair === "USDC/iso4217:NGN");
    expect(ngnPair).toBeDefined();
    expect(ngnPair?.displayPair).toBe("USDC/NGN");
    expect(ngnPair?.points).toHaveLength(30);
  });

  it("calculates P25 estimate band below or equal to the reference rate", () => {
    const data = getDailySummaryData();
    for (const pair of data.pairs) {
      expect(pair.referenceRate).toBeGreaterThan(0);
      for (const pt of pair.points) {
        expect(pt.referenceRate).toBeGreaterThan(0);
        expect(pt.p25).toBeGreaterThan(0);
        // P25 band must be bounded below or at the reference rate
        expect(pt.p25).toBeLessThanOrEqual(pt.referenceRate);
      }
    }
  });

  it("contains marked gaps (null values) where no data was collected", () => {
    const data = getDailySummaryData();
    const usdPair = data.pairs.find((p) => p.pair === "USDC/iso4217:USD");
    expect(usdPair).toBeDefined();

    const anchorWithGap = "testanchor.stellar.org";
    const gapPoints = usdPair!.points.filter((pt) => pt.rates[anchorWithGap] === null);

    // Deliberate gaps exist in the dataset
    expect(gapPoints.length).toBeGreaterThan(0);
  });

  it("builds discontinuous path segments without drawing through missing gaps", () => {
    const mockPoints: DailyRatePoint[] = [
      {
        date: "2026-11-01",
        referenceRate: 1.0,
        p25: 0.99,
        rates: { "anchor-a": 1.01 },
      },
      {
        date: "2026-11-02",
        referenceRate: 1.0,
        p25: 0.99,
        rates: { "anchor-a": 1.02 },
      },
      // GAP: null rate
      {
        date: "2026-11-03",
        referenceRate: 1.0,
        p25: 0.99,
        rates: { "anchor-a": null },
      },
      {
        date: "2026-11-04",
        referenceRate: 1.0,
        p25: 0.99,
        rates: { "anchor-a": 1.015 },
      },
      {
        date: "2026-11-05",
        referenceRate: 1.0,
        p25: 0.99,
        rates: { "anchor-a": 1.018 },
      },
    ];

    const mapX = (i: number) => i * 100;
    const mapY = (r: number) => 500 - r * 100;

    const segments = buildAnchorSegments(mockPoints, "anchor-a", mapX, mapY);

    // Must be split into 2 separate segments because of the gap on day 3
    expect(segments).toHaveLength(2);
    expect(segments[0].points).toHaveLength(2);
    expect(segments[0].points[0].date).toBe("2026-11-01");
    expect(segments[0].points[1].date).toBe("2026-11-02");

    expect(segments[1].points).toHaveLength(2);
    expect(segments[1].points[0].date).toBe("2026-11-04");
    expect(segments[1].points[1].date).toBe("2026-11-05");

    const svgPath = segmentsToSvgPath(segments);
    // Must contain two separate 'M' commands and no continuous line through day 3
    expect(svgPath).toContain("M 0.00");
    expect(svgPath).toContain("M 300.00");
    expect(svgPath).not.toContain("L 200.00"); // day 3 (x=200) was a gap and must not be in path
  });

  it("handles continuous data with no gaps as a single segment", () => {
    const mockPoints: DailyRatePoint[] = [
      { date: "2026-11-01", referenceRate: 1.0, p25: 0.99, rates: { "anchor-b": 1.0 } },
      { date: "2026-11-02", referenceRate: 1.0, p25: 0.99, rates: { "anchor-b": 1.01 } },
      { date: "2026-11-03", referenceRate: 1.0, p25: 0.99, rates: { "anchor-b": 1.02 } },
    ];

    const segments = buildAnchorSegments(
      mockPoints,
      "anchor-b",
      (i) => i * 10,
      (r) => r * 10,
    );
    expect(segments).toHaveLength(1);
    expect(segments[0].points).toHaveLength(3);

    const svgPath = segmentsToSvgPath(segments);
    expect(svgPath.startsWith("M 0.00")).toBe(true);
    // Only one M command
    expect(svgPath.split("M")).toHaveLength(2);
  });

  it("returns empty string when no segments exist", () => {
    expect(segmentsToSvgPath([])).toBe("");
  });

  it("serves daily summary via route handler", async () => {
    const req = new Request("http://localhost:3000/api/rates/daily-summary");
    const res = await getDailySummaryRoute(req);
    expect(res.status).toBe(200);

    const json = (await res.json()) as { pairs: unknown[] };
    expect(Array.isArray(json.pairs)).toBe(true);
    expect(json.pairs.length).toBeGreaterThanOrEqual(4);
  });

  it("filters to a specific pair via query param", async () => {
    const req = new Request("http://localhost:3000/api/rates/daily-summary?pair=USDC/USD");
    const res = await getDailySummaryRoute(req);
    expect(res.status).toBe(200);

    const json = (await res.json()) as { pairs: { displayPair: string }[] };
    expect(json.pairs).toHaveLength(1);
    expect(json.pairs[0].displayPair).toBe("USDC/USD");
  });

  it("returns 404 for unknown pair query param", async () => {
    const req = new Request("http://localhost:3000/api/rates/daily-summary?pair=UNKNOWN/PAIR");
    const res = await getDailySummaryRoute(req);
    expect(res.status).toBe(404);

    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("pair_not_found");
  });
});
