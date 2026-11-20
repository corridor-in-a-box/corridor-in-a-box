import { describe, expect, it } from "vitest";
import { compareAmounts } from "@corridor/types";
import { applyEstimateMargin, fetchIndicativePrice } from "@corridor/router";

describe("router indicative price from SEP-38 /price (#609)", () => {
  it("queries SEP-38 GET /price and computes cautiousDestAmount with estimateMarginBps", async () => {
    let seenUrl = "";
    let seenAuth = "";

    const res = await fetchIndicativePrice({
      domain: "indicative.example",
      quoteServer: "https://indicative.example/sep38",
      sellAsset: "stellar:USDC:GISSUER",
      buyAsset: "iso4217:NGN",
      sellAmount: "100",
      estimateMarginBps: 50,
      authToken: "jwt-123",
      fetchImpl: (async (url: string | URL, init?: RequestInit) => {
        seenUrl = String(url);
        seenAuth = ((init?.headers ?? {}) as Record<string, string>).authorization ?? "";
        return new Response(
          JSON.stringify({
            price: "1500",
            total_price: "1500",
            sell_amount: "100",
            buy_amount: "150000",
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(seenUrl).toContain("https://indicative.example/sep38/price?");
    expect(seenUrl).toContain("context=sep31");
    expect(seenUrl).toContain("sell_amount=100");
    expect(seenAuth).toBe("Bearer jwt-123");

    expect(res.value.label).toBe("indicative");
    expect(res.value.destAmount).toBe("150000");
    // 150,000 * (1 - 50/10000) = 150,000 * 0.995 = 149250
    expect(res.value.cautiousDestAmount).toBe("149250");
    expect(res.value.reason).toContain("indicative");
  });

  it("ranks indicative cautiousDestAmount below an equal raw-rate locked option due to margin", () => {
    const discounted = applyEstimateMargin("1000", 100);
    expect(discounted.ok).toBe(true);
    if (!discounted.ok) return;
    expect(discounted.value).toBe("990");
    expect(compareAmounts(discounted.value, "1000")).toEqual({ ok: true, value: -1 });
  });

  it("fails closed when quote_server is missing or GET /price fails", async () => {
    const noServer = await fetchIndicativePrice({
      domain: "none.example",
      sellAsset: "stellar:USDC:GISSUER",
      buyAsset: "iso4217:NGN",
      sellAmount: "100",
    });
    expect(noServer.ok).toBe(false);
    if (!noServer.ok) expect(noServer.error.code).toBe("QUOTE_UNAVAILABLE");

    const http503 = await fetchIndicativePrice({
      domain: "err.example",
      quoteServer: "https://err.example/sep38",
      sellAsset: "stellar:USDC:GISSUER",
      buyAsset: "iso4217:NGN",
      sellAmount: "100",
      fetchImpl: (async () => new Response("down", { status: 503 })) as typeof fetch,
    });
    expect(http503.ok).toBe(false);
    if (!http503.ok) expect(http503.error.retryable).toBe(true);
  });
});
