// rank() — pure, deterministic ranking of route options. RFC 0004 §1 "Ranking", issue #611.
//
// Sort key, most important first:
//   1. Cautious recipient amount, higher first. rank() works it out from the
//      price label (RFC 0004 §1 "Ranking", D3):
//        locked      → the quoted amount, as is (the anchor is bound to it);
//        indicative  → the indicative amount minus the estimate margin;
//        estimated   → the P25 amount minus the estimate margin.
//      All of it is decimal-string arithmetic on scaled BigInts (@corridor/types);
//      no amount ever becomes a JS number.
//   2. reliability, higher first (0..1, RouteOption.reliability).
//   3. estimatedDeliveryMs, lower (faster) first. Unknown counts as slowest.
//   4. receivingDomain, ascending by UTF-16 code unit, so the order never
//      depends on the runtime's locale.
//   5. Input position, so options equal on every key keep their input order.
//
// No hidden weights: each key only breaks ties left by the ones above it.

import { compareAmounts, toScaled, type Money } from "@corridor/types";
import { applyEstimateMargin, DEFAULT_ESTIMATE_MARGIN_BPS } from "./indicative-price";
import type { PriceLabel, RoutePolicy } from "./planner";

/**
 * The fields rank() reads. A full RFC 0004 `RouteOption` satisfies it, so the
 * planner can rank its own options directly.
 */
export interface RankableOption {
  /** Receiving anchor's home domain; the last tie-break. */
  readonly receivingDomain: string;
  /** Only the label is read: it decides whether the estimate margin applies. */
  readonly price: { readonly label: PriceLabel };
  /**
   * What the recipient gets after fees at the option's own price, **before**
   * any estimate margin. rank() applies the margin itself:
   * - `locked`: the firm quote's amount.
   * - `indicative`: the amount at the anchor's current price
   *   (`IndicativeRouteOption.destAmount`, not its `cautiousDestAmount`).
   * - `estimated`: the amount at the P25 rate (`sourceAmount × price.p25Rate`),
   *   not `EstimatedPriceOffered.estimatedDestAmount`, which already has the
   *   margin taken off.
   *
   * Every option ranked together must be in the same asset.
   */
  readonly recipientGets: Money;
  /** This business's success rate on the anchor, 0..1. Higher is better. */
  readonly reliability: number;
  /**
   * Expected time to deliver, in milliseconds. Lower is better. Leave it out
   * when unknown: the option then loses the speed tie-break to any known time.
   */
  readonly estimatedDeliveryMs?: number;
}

/** rank() settings, named as in `RoutePolicy` so a request's policy can be passed as is. */
export type RankOptions = Pick<RoutePolicy, "estimateMarginBps">;

function checkMarginBps(marginBps: number): void {
  if (!Number.isInteger(marginBps) || marginBps < 0 || marginBps >= 10_000) {
    throw new RangeError(
      `estimateMarginBps must be an integer in [0, 9999] (got ${marginBps})`,
    );
  }
}

/**
 * The amount rank() sorts by: `recipientGets.amount` for a `locked` option, and
 * that amount minus `marginBps` basis points (rounded half-up to 7 places) for
 * `indicative` and `estimated`. Throws a RangeError for a malformed or negative
 * amount, or a margin outside [0, 9999].
 */
export function cautiousRecipientAmount(
  option: RankableOption,
  marginBps: number = DEFAULT_ESTIMATE_MARGIN_BPS,
): string {
  checkMarginBps(marginBps);
  const amount = option.recipientGets.amount;
  const scaled = toScaled(amount);
  if (!scaled.ok) {
    throw new RangeError(`${option.receivingDomain}: recipientGets ${scaled.error.message}`);
  }
  if (scaled.value < 0n) {
    throw new RangeError(
      `${option.receivingDomain}: recipientGets must not be negative (got "${amount}")`,
    );
  }
  const label = option.price.label;
  if (label === "locked") return amount;
  if (label !== "indicative" && label !== "estimated") {
    throw new RangeError(
      `${option.receivingDomain}: unknown price label ${JSON.stringify(label)}`,
    );
  }
  const cautious = applyEstimateMargin(amount, marginBps);
  if (!cautious.ok) {
    throw new RangeError(`${option.receivingDomain}: ${cautious.error.message}`);
  }
  return cautious.value;
}

function checkTieBreakers(option: RankableOption): void {
  const { reliability, estimatedDeliveryMs, receivingDomain } = option;
  if (typeof reliability !== "number" || !(reliability >= 0 && reliability <= 1)) {
    throw new RangeError(
      `${receivingDomain}: reliability must be a number from 0 to 1 (got ${String(reliability)})`,
    );
  }
  if (
    estimatedDeliveryMs !== undefined &&
    !(Number.isFinite(estimatedDeliveryMs) && estimatedDeliveryMs >= 0)
  ) {
    throw new RangeError(
      `${receivingDomain}: estimatedDeliveryMs must be a finite number >= 0 (got ${String(estimatedDeliveryMs)})`,
    );
  }
}

/** -1, 0 or 1 by UTF-16 code unit: the same answer under every locale. */
function compareCodeUnits(a: string, b: string): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Sort route options best-for-the-recipient first (RFC 0004 §1 "Ranking").
 *
 * Returns a new array holding the same option objects; the input is never
 * mutated. Throws a RangeError, before sorting anything, when an option has a
 * malformed or negative amount, an unknown label, a reliability outside 0..1,
 * a bad delivery time, or when the options are in different assets.
 *
 * @param options  The options to rank. May be empty.
 * @param settings `estimateMarginBps` (default 50, RFC 0004 D3), taken off
 *                 `indicative` and `estimated` amounts.
 */
export function rank<T extends RankableOption>(
  options: readonly T[],
  settings: RankOptions = {},
): T[] {
  const marginBps = settings.estimateMarginBps ?? DEFAULT_ESTIMATE_MARGIN_BPS;
  checkMarginBps(marginBps);

  const asset = options[0]?.recipientGets.asset;
  const keyed = options.map((option, index) => {
    if (option.recipientGets.asset !== asset) {
      throw new RangeError(
        `cannot rank amounts in different assets: ${String(asset)} and ${option.recipientGets.asset}`,
      );
    }
    checkTieBreakers(option);
    return { option, index, cautious: cautiousRecipientAmount(option, marginBps) };
  });

  keyed.sort((a, b) => {
    // 1. Cautious amount, higher first. Both were validated above.
    const byAmount = compareAmounts(b.cautious, a.cautious);
    if (byAmount.ok && byAmount.value !== 0) return byAmount.value;

    // 2. Reliability, higher first.
    if (a.option.reliability !== b.option.reliability) {
      return a.option.reliability > b.option.reliability ? -1 : 1;
    }

    // 3. Delivery time, lower first; unknown is slowest.
    const msA = a.option.estimatedDeliveryMs;
    const msB = b.option.estimatedDeliveryMs;
    if (msA !== msB) {
      if (msA === undefined) return 1;
      if (msB === undefined) return -1;
      return msA < msB ? -1 : 1;
    }

    // 4. Domain, ascending, locale-independent.
    const byDomain = compareCodeUnits(a.option.receivingDomain, b.option.receivingDomain);
    if (byDomain !== 0) return byDomain;

    // 5. Input order.
    return a.index - b.index;
  });

  return keyed.map(({ option }) => option);
}
