import { describe, expect, it } from "vitest";
import {
  calculateMedian,
  isRateOutlier,
  computeP25,
  flagOutliers,
  RateSampleCollector,
  computeDailySummary,
  type RateSample,
} from "../packages/router/src/rate-history";
import { loadFleet } from "../packages/probe/src/fleet";

describe("Rate history outlier sample detection (#602)", () => {
  it("computes accurate medians for odd and even arrays", () => {
    expect(calculateMedian([])).toBeUndefined();
    expect(calculateMedian([100])).toBe(100);
    expect(calculateMedian([100, 200, 300])).toBe(200);
    expect(calculateMedian([100, 200, 300, 400])).toBe(250);
    expect(calculateMedian([400, 100, 300, 200])).toBe(250);
  });

  it("checks whether a rate is an outlier against baseline median", () => {
    // Median 1000, 10% default threshold (900 - 1100)
    expect(isRateOutlier(1050, 1000)).toBe(false); // 5% deviation
    expect(isRateOutlier(950, 1000)).toBe(false); // 5% deviation
    expect(isRateOutlier(1100, 1000)).toBe(false); // exactly 10%
    expect(isRateOutlier(1105, 1000)).toBe(true); // 10.5% deviation -> outlier
    expect(isRateOutlier(890, 1000)).toBe(true); // 11% deviation -> outlier

    // Custom threshold: 5% (0.05)
    expect(isRateOutlier(1060, 1000, 0.05)).toBe(true);
    expect(isRateOutlier(1030, 1000, 0.05)).toBe(false);

    // Custom threshold: 20% (0.20)
    expect(isRateOutlier(1150, 1000, 0.2)).toBe(false);
    expect(isRateOutlier(1250, 1000, 0.2)).toBe(true);

    // Edge cases: invalid or zero median
    expect(isRateOutlier(100, 0)).toBe(false);
    expect(isRateOutlier(NaN, 1000)).toBe(false);
  });

  it("flags outlier samples while preserving all samples in the dataset", () => {
    const baseTime = 1700000000000;
    const rawSamples: RateSample[] = [
      {
        pair: "USDC:iso4217:NGN",
        rate: "1600.0000000",
        source: "sep38_price",
        network: "public",
        sampledAt: baseTime,
        anchorDomain: "cowrie.exchange",
      },
      {
        pair: "USDC:iso4217:NGN",
        rate: "1605.0000000",
        source: "sep38_price",
        network: "public",
        sampledAt: baseTime + 60000,
        anchorDomain: "cowrie.exchange",
      },
      {
        pair: "USDC:iso4217:NGN",
        rate: "1595.0000000",
        source: "sep38_price",
        network: "public",
        sampledAt: baseTime + 120000,
        anchorDomain: "cowrie.exchange",
      },
      // Spikes: 2400 (50% spike) and 800 (50% drop)
      {
        pair: "USDC:iso4217:NGN",
        rate: "2400.0000000",
        source: "sep38_price",
        network: "public",
        sampledAt: baseTime + 180000,
        anchorDomain: "cowrie.exchange",
      },
      {
        pair: "USDC:iso4217:NGN",
        rate: "800.0000000",
        source: "sep38_price",
        network: "public",
        sampledAt: baseTime + 240000,
        anchorDomain: "cowrie.exchange",
      },
      // Normal continuation
      {
        pair: "USDC:iso4217:NGN",
        rate: "1602.0000000",
        source: "sep38_price",
        network: "public",
        sampledAt: baseTime + 300000,
        anchorDomain: "cowrie.exchange",
      },
    ];

    const flagged = flagOutliers(rawSamples);

    // Total count preserved: no samples deleted
    expect(flagged.length).toBe(6);

    // Normal samples are unflagged
    expect(flagged[0]?.outlier).toBe(false);
    expect(flagged[1]?.outlier).toBe(false);
    expect(flagged[2]?.outlier).toBe(false);
    expect(flagged[5]?.outlier).toBe(false);

    // Anomalous samples are flagged as outliers
    expect(flagged[3]?.outlier).toBe(true);
    expect(flagged[3]?.outlierReason).toContain("exceeds threshold 10%");
    expect(flagged[4]?.outlier).toBe(true);
    expect(flagged[4]?.outlierReason).toContain("exceeds threshold 10%");
  });

  it("excludes flagged outliers from P25 while keeping them visible in the dataset", () => {
    const baseTime = 1700000000000;
    const samples: RateSample[] = [
      {
        pair: "USDC:iso4217:KES",
        rate: "130.0000000",
        source: "sep38_price",
        network: "public",
        sampledAt: baseTime,
        anchorDomain: "connect.clickpesa.com",
        outlier: false,
      },
      {
        pair: "USDC:iso4217:KES",
        rate: "131.0000000",
        source: "sep38_price",
        network: "public",
        sampledAt: baseTime + 60000,
        anchorDomain: "connect.clickpesa.com",
        outlier: false,
      },
      {
        pair: "USDC:iso4217:KES",
        rate: "132.0000000",
        source: "sep38_price",
        network: "public",
        sampledAt: baseTime + 120000,
        anchorDomain: "connect.clickpesa.com",
        outlier: false,
      },
      {
        pair: "USDC:iso4217:KES",
        rate: "133.0000000",
        source: "sep38_price",
        network: "public",
        sampledAt: baseTime + 180000,
        anchorDomain: "connect.clickpesa.com",
        outlier: false,
      },
      // Bad sample that would severely distort P25 downwards if included
      {
        pair: "USDC:iso4217:KES",
        rate: "10.0000000",
        source: "sep38_price",
        network: "public",
        sampledAt: baseTime + 240000,
        anchorDomain: "connect.clickpesa.com",
        outlier: true,
        outlierReason: "Price collapse spike",
      },
    ];

    // Total samples are all visible in data
    expect(samples.length).toBe(5);
    expect(samples.filter((s) => s.outlier).length).toBe(1);

    // Compute P25 excluding outliers (default behavior)
    const p25Clean = computeP25(samples);
    expect(p25Clean).toBeDefined();
    // Valid samples: 130, 131, 132, 133. P25 = 130 + 0.25 * 3 = 130.75
    expect(parseFloat(p25Clean!)).toBeCloseTo(130.75, 2);

    // If outliers were erroneously included, P25 would be dragged down towards 10
    const p25Polluted = computeP25(samples, { excludeOutliers: false });
    // Sorted with outlier: 10, 130, 131, 132, 133. P25 = 10 + 1 * (130 - 10) = 130
    expect(parseFloat(p25Polluted!)).toBeLessThan(parseFloat(p25Clean!));
  });

  it("handles online sample recording with RateSampleCollector and threshold options", () => {
    const collector = new RateSampleCollector({ threshold: 0.1 });
    const baseTime = new Date("2026-11-19T10:00:00Z").getTime();

    // Baseline samples around 100
    collector.recordSample({
      pair: "USDC:iso4217:ZAR",
      rate: "18.0000000",
      source: "sep38_price",
      network: "public",
      sampledAt: baseTime,
      anchorDomain: "mint.zeam.money",
    });
    collector.recordSample({
      pair: "USDC:iso4217:ZAR",
      rate: "18.1000000",
      source: "sep38_price",
      network: "public",
      sampledAt: baseTime + 60000,
      anchorDomain: "mint.zeam.money",
    });
    collector.recordSample({
      pair: "USDC:iso4217:ZAR",
      rate: "18.0500000",
      source: "sep38_price",
      network: "public",
      sampledAt: baseTime + 120000,
      anchorDomain: "mint.zeam.money",
    });

    // 25.0 is a ~38% jump -> should be flagged as outlier
    const badSample = collector.recordSample({
      pair: "USDC:iso4217:ZAR",
      rate: "25.0000000",
      source: "sep38_price",
      network: "public",
      sampledAt: baseTime + 180000,
      anchorDomain: "mint.zeam.money",
    });

    expect(badSample.outlier).toBe(true);

    // Verify collector visibility: all 4 samples are preserved
    expect(collector.getSamples("public").length).toBe(4);
    // Filtered view excludes the outlier
    expect(collector.getSamples("public", { excludeOutliers: true }).length).toBe(3);
    // Outliers query returns the flagged sample
    expect(collector.getOutliers("public").length).toBe(1);
    expect(collector.getOutliers("public")[0]?.rate).toBe("25.0000000");

    // Daily summary excludes outlier from percentiles but reports outlierCount
    const summary = computeDailySummary(
      collector.getSamples("public"),
      "public",
      "USDC:iso4217:ZAR",
      "2026-11-19",
    );
    expect(summary).toBeDefined();
    expect(summary?.count).toBe(4);
    expect(summary?.validCount).toBe(3);
    expect(summary?.outlierCount).toBe(1);
    expect(parseFloat(summary!.high)).toBeCloseTo(18.1, 1); // 25.0 excluded from high
  });
});

describe("Anchor fleet probe documentation and African expansion (#660, #661, #664)", () => {
  it("documents probe findings for Flutterwave (#660) and Bitso (#661)", () => {
    const fleet = loadFleet();
    const comment = (fleet.$comment ?? []).join("\n");

    // Flutterwave probe documentation
    expect(comment).toContain("flutterwave.com");
    expect(comment).toContain("HTTP 404");
    expect(comment).toContain("2026-11-19");

    // Bitso probe documentation
    expect(comment).toContain("bitso.com");
    expect(comment).toContain("ENOTFOUND");
    expect(comment).toContain("2026-11-19");
  });

  it("includes 5 African anchors in fleet with verified sources and metadata (#664)", () => {
    const fleet = loadFleet();

    const expectedAfricanDomains = [
      "yellowcard.io",
      "paychant.com",
      "fonbnk.com",
      "honeycoin.app",
      "kotanipay.com",
    ];

    for (const domain of expectedAfricanDomains) {
      expect(fleet.domains).toContain(domain);
      const entry = fleet.anchors.find((a) => a.domain === domain);
      expect(entry).toBeDefined();
      expect(entry?.added).toBe("2026-11-19");
      expect(entry?.countries.length).toBeGreaterThan(0);
      expect(entry?.source).toBeDefined();
    }
  });
});
