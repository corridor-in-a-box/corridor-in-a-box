// Indicative price fetcher using SEP-38 GET /price (#609).
//
// When an anchor offers no firm quote (POST /quote) but exposes a live rate
// feed (GET /price), the option is labelled "indicative" and its ranking amount
// (`cautiousDestAmount`) is discounted by `estimateMarginBps`.

import {
  applyPrice,
  fail,
  fromScaled,
  isValidAmount,
  ok,
  STROOP_SCALE,
  type Outcome,
} from "@corridor/types";

export const DEFAULT_ESTIMATE_MARGIN_BPS = 100; // 1.00%

export interface IndicativePriceRequest {
  readonly domain: string;
  readonly protocol?: string;
  readonly quoteServer?: string;
  readonly sellAsset: string;
  readonly buyAsset: string;
  readonly sellAmount: string;
  /** SEP-38 context query parameter (default `"sep31"`). */
  readonly context?: string;
  /** Safety discount applied to `destAmount` when ranking (default 100 bps). */
  readonly estimateMarginBps?: number;
  /** Optional SEP-10 bearer JWT if the anchor authenticates GET /price. */
  readonly authToken?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface IndicativeRouteOption {
  readonly domain: string;
  readonly receivingDomain: string;
  readonly protocol: string;
  readonly label: "indicative";
  readonly price: {
    readonly label: "indicative";
    readonly rate: string;
    readonly destAmount: string;
    readonly cautiousDestAmount: string;
  };
  readonly destAmount: string;
  readonly cautiousDestAmount: string;
  readonly marginBps: number;
  readonly reason: string;
}

/**
 * Compute `amount * (1 - marginBps / 10_000)` using scaled BigInt arithmetic so
 * floating-point precision loss is impossible.
 */
export function applyEstimateMargin(
  amount: string,
  marginBps: number = DEFAULT_ESTIMATE_MARGIN_BPS,
  scale = STROOP_SCALE,
): Outcome<string> {
  if (!Number.isInteger(marginBps) || marginBps < 0 || marginBps >= 10_000) {
    return fail(
      "AMOUNT_INVALID",
      `estimateMarginBps must be an integer in [0, 9999] (got ${marginBps})`,
    );
  }
  const factor = 10n ** BigInt(scale);
  const multiplierScaled = (BigInt(10_000 - marginBps) * factor) / 10_000n;
  const multiplier = fromScaled(multiplierScaled, scale);
  return applyPrice(amount, multiplier, scale);
}

/**
 * Fetch an indicative price via SEP-38 `GET /price` and compute the discounted
 * `cautiousDestAmount` used for ranking.
 */
export async function fetchIndicativePrice(
  req: IndicativePriceRequest,
): Promise<Outcome<IndicativeRouteOption>> {
  const quoteServer = req.quoteServer?.replace(/\/+$/, "");
  if (!quoteServer) {
    return fail("QUOTE_UNAVAILABLE", `${req.domain}: anchor exposes no SEP-38 quote server`);
  }

  const marginBps = req.estimateMarginBps ?? DEFAULT_ESTIMATE_MARGIN_BPS;
  const fetchImpl = req.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    context: req.context ?? "sep31",
    sell_asset: req.sellAsset,
    buy_asset: req.buyAsset,
    sell_amount: req.sellAmount,
  });

  try {
    const res = await fetchImpl(`${quoteServer}/price?${params.toString()}`, {
      method: "GET",
      headers: req.authToken ? { authorization: `Bearer ${req.authToken}` } : undefined,
    });
    if (!res.ok) {
      return fail("QUOTE_UNAVAILABLE", `${req.domain}: GET /price HTTP ${res.status}`, {
        retryable: res.status >= 500,
      });
    }

    const body = (await res.json()) as {
      price?: string;
      total_price?: string;
      buy_amount?: string;
      sell_amount?: string;
    };

    const rate = body.price ?? body.total_price;
    if (typeof rate !== "string" || !isValidAmount(rate)) {
      return fail("QUOTE_UNAVAILABLE", `${req.domain}: GET /price returned invalid price`);
    }

    let destAmount: string;
    if (typeof body.buy_amount === "string" && isValidAmount(body.buy_amount)) {
      destAmount = body.buy_amount;
    } else {
      const derived = applyPrice(req.sellAmount, rate);
      if (!derived.ok) return derived;
      destAmount = derived.value;
    }

    const cautious = applyEstimateMargin(destAmount, marginBps);
    if (!cautious.ok) return cautious;

    return ok({
      domain: req.domain,
      receivingDomain: req.domain,
      protocol: req.protocol ?? "sep31",
      label: "indicative",
      price: {
        label: "indicative",
        rate,
        destAmount,
        cautiousDestAmount: cautious.value,
      },
      destAmount,
      cautiousDestAmount: cautious.value,
      marginBps,
      reason: `indicative: live /price (-${marginBps} bps margin)`,
    });
  } catch (cause) {
    return fail("ANCHOR_UNAVAILABLE", `${req.domain}: GET /price request failed`, {
      retryable: true,
      cause,
    });
  }
}
