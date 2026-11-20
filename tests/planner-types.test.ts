import { describe, expect, it } from "vitest";
import type {
  DroppedRouteOption,
  PlannerPolicy,
  PriceLabel,
  RouteOption,
  RoutePlan,
  RoutePlanner,
  RoutePrice,
  RouteRequest,
} from "@corridor/router";

describe("@corridor/router planner types (#603)", () => {
  it("exports PriceLabel, RouteRequest, RouteOption, DroppedRouteOption, RoutePlan and RoutePlanner", async () => {
    const labels: readonly PriceLabel[] = ["locked", "indicative", "estimated"];
    expect(labels).toHaveLength(3);

    const policy: PlannerPolicy = {
      estimateWindowDays: 7,
      estimateMarginBps: 50,
      allowedLabels: ["locked", "indicative"],
      deadlineMs: 5_000,
      perAnchorTimeoutMs: 2_000,
    };

    const request: RouteRequest = {
      sourceAmount: { asset: "USDC", amount: "100" },
      destAsset: "iso4217:NGN",
      corridorId: "usdc-ngn",
      suppliedFields: { account_number: "0123456789" },
      policy,
    };

    const price: RoutePrice = {
      label: "locked",
      rate: "1550",
      destAmount: "155000",
      cautiousDestAmount: "155000",
      quoteId: "q-123",
      expiresAt: 1_900_000_060_000,
    };

    const offered: RouteOption = {
      domain: "anchor.example",
      receivingDomain: "anchor.example",
      protocol: "sep31",
      label: "locked",
      price,
      cautiousDestAmount: "155000",
      destAmount: "155000",
      quoteId: "q-123",
      expiresAt: 1_900_000_060_000,
      reliability: 0.99,
      estimatedDeliveryMs: 12_000,
      reason: "locked for 60 s",
    };

    const dropped: DroppedRouteOption = {
      domain: "paused.example",
      receivingDomain: "paused.example",
      protocol: "sep31",
      dropped: true,
      reason: "dropped: amount above max 5,000",
    };

    const planner: RoutePlanner = {
      async plan(req: RouteRequest): Promise<RoutePlan> {
        return {
          request: req,
          offered: [offered],
          dropped: [dropped],
        };
      },
    };

    const result = await planner.plan(request);
    expect(result.offered[0]?.label).toBe("locked");
    expect(result.dropped[0]?.dropped).toBe(true);
    expect(result.dropped[0]?.reason).toContain("dropped:");
  });
});
