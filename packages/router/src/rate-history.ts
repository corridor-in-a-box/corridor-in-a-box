// Rate-history minimum-data rule for `estimated` prices (RFC 0004 §3).
//
// An anchor gets an `estimated` price for a pair only when its rate history
// is deep enough: at least 7 days of data and at least 100 samples in the
// window. Below either threshold the pair is unpriceable at that anchor —
// too little data must never be presented as a price (docs/threat-model.md).
//
// The rule itself lives in `buildEstimatedOption` (estimated-price.ts). This
// helper asks it, so "can this pair be estimated" and "the estimated option"
// can never disagree: same thresholds, same sample filtering, same P25.

import {
  buildEstimatedOption,
  DEFAULT_ESTIMATE_WINDOW_DAYS,
  DEFAULT_MIN_ESTIMATE_SAMPLES,
  DEFAULT_MIN_ESTIMATE_SPAN_DAYS,
  type RateSample,
} from "./estimated-price";

/**
 * The minimum-data thresholds, configurable per business (RFC 0004 §3).
 * Each one defaults to the RFC value in `estimated-price.ts` when omitted.
 */
export interface EstimateThresholds {
  /** Minimum number of usable samples inside the window (default `DEFAULT_MIN_ESTIMATE_SAMPLES`, 100). */
  readonly minSamples?: number;
  /**
   * How far back the whole supplied history must reach, in days: `now - oldest usable sample`
   * (default `DEFAULT_MIN_ESTIMATE_SPAN_DAYS`, 7). Measured over all the history passed in, not
   * only the window, so a 15-minute collector is not one interval short of the window.
   */
  readonly minDays?: number;
  /** Length of the estimate window the samples are counted in, in days (default `DEFAULT_ESTIMATE_WINDOW_DAYS`, 7). */
  readonly windowDays?: number;
}

/**
 * Whether a pair at an anchor can carry an `estimated` price: either the
 * lower-quartile rate (P25, RFC 0004 D3) and the number of in-window samples
 * behind it, or the reason the history is not deep enough.
 */
export type EstimateAssessment =
  | { readonly ok: true; readonly p25: string; readonly samples: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Applies the minimum-data rule to the rate history held for one pair at one
 * anchor. Pass the whole stored history, not only the window: the samples are
 * counted inside the window (`windowDays` up to `nowMs`), while the span is
 * measured over everything passed in, as `nowMs - oldest usable sample`.
 *
 * A sample is usable when its rate is a positive decimal string, its time is
 * finite and not after `nowMs`, and it is not flagged as an outlier (#602).
 * Any other sample is left out, so it is never counted and never priced.
 *
 * When both thresholds are met the result carries the P25 by the shared
 * "lower" method (`rate-percentile.ts`): an observed rate in canonical form,
 * never an interpolation. Below either threshold it carries the reason from
 * `buildEstimatedOption`; the sample count is checked first.
 *
 * Throws `RangeError` on a threshold that is out of range, as
 * `buildEstimatedOption` does.
 */
export function assessRateHistory(
  history: readonly RateSample[],
  thresholds?: EstimateThresholds,
  nowMs: number = Date.now(),
): EstimateAssessment {
  // The P25 and the thresholds do not depend on the amount or the margin, so
  // price one unit at zero margin and read only the rate and the count back.
  const outcome = buildEstimatedOption({
    receivingDomain: "",
    sourceAmount: { asset: "", amount: "1" },
    destAsset: "",
    history,
    nowMs,
    policy: {
      estimateMarginBps: 0,
      estimateWindowDays: thresholds?.windowDays ?? DEFAULT_ESTIMATE_WINDOW_DAYS,
      minEstimateSamples: thresholds?.minSamples ?? DEFAULT_MIN_ESTIMATE_SAMPLES,
      minEstimateSpanDays: thresholds?.minDays ?? DEFAULT_MIN_ESTIMATE_SPAN_DAYS,
    },
  });

  if (outcome.status === "dropped") {
    return { ok: false, reason: outcome.reason };
  }
  return { ok: true, p25: outcome.price.p25Rate, samples: outcome.price.sampleCount };
}
