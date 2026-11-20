// rank() — pure, deterministic ranking of route options. RFC 0004 / issue #611.
//
// Sort key (descending priority):
//   1. cautiousDestAmount — the pre-computed cautious recipient amount; higher is
//      better. Parsed as a scaled BigInt so float imprecision is impossible.
//   2. reliability        — historical success rate 0..1; higher is better.
//      Undefined is treated as 0.5 (neutral / no data).
//   3. estimatedDeliveryMs — expected end-to-end delivery time; lower is better
//      (faster). Undefined is treated as Infinity (slowest).
//   4. domain             — ascending alphabetical; makes the final order
//      deterministic when all other criteria are equal.
//
// No hidden weights. The sort key is fully transparent to callers.

import { toScaled } from "@corridor/types";

/** The fields rank() reads. Extend with any domain-specific extras. */
export interface RankableOption {
  /** Receiving anchor's home domain — used as final tiebreak. */
  readonly domain: string;
  /** How firmly this price is held. */
  readonly label: "locked" | "indicative" | "estimated";
  /**
   * Pre-computed cautious recipient amount as a decimal string (e.g. "9823.50").
   *
   * The caller is responsible for computing the cautious value per label:
   *   locked      → the firm quote destAmount (no discount; rate is guaranteed)
   *   indicative  → destAmount minus an estimate-margin discount
   *   estimated   → P25 of rate-history window minus estimate-margin discount
   *
   * rank() receives already-cautious values and sorts them descending.
   */
  readonly cautiousDestAmount: string;
  /**
   * Business's historical success rate on this anchor, 0..1.
   * Higher is better. Undefined is treated as 0.5 (neutral / no data).
   */
  readonly reliability?: number;
  /**
   * Expected end-to-end delivery time in milliseconds.
   * Lower is better (faster). Undefined is treated as Infinity.
   */
  readonly estimatedDeliveryMs?: number;
}

/**
 * Sort route options for display: best-for-recipient first, no hidden weights.
 *
 * Returns a **new** array — the input is never mutated. The relative order of
 * options that compare equal on every criterion is preserved (stable sort via
 * index tiebreak appended internally).
 *
 * @param options  Array of route options to rank. May be empty.
 * @returns        New sorted array, best option at index 0.
 */
export function rank<T extends RankableOption>(options: readonly T[]): T[] {
  // Tag each element with its original index so equal-on-all-criteria options
  // keep their input order (stable sort, even on engines that are not stable).
  const tagged = options.map((opt, idx) => ({ opt, idx }));

  tagged.sort(({ opt: a, idx: ia }, { opt: b, idx: ib }) => {
    // 1. cautiousDestAmount descending (BigInt — no float rounding)
    const scaledA = toScaled(a.cautiousDestAmount);
    const scaledB = toScaled(b.cautiousDestAmount);
    // If either amount is malformed, fall through to domain tiebreak so the
    // sort still terminates; callers should validate before ranking.
    if (scaledA.ok && scaledB.ok) {
      if (scaledB.value > scaledA.value) return 1;
      if (scaledB.value < scaledA.value) return -1;
    }

    // 2. reliability descending (higher = more reliable)
    const relA = a.reliability ?? 0.5;
    const relB = b.reliability ?? 0.5;
    if (relB !== relA) return relB - relA;

    // 3. speed ascending (lower ms = faster delivery)
    const spdA = a.estimatedDeliveryMs ?? Infinity;
    const spdB = b.estimatedDeliveryMs ?? Infinity;
    if (spdA !== spdB) return spdA - spdB;

    // 4. domain ascending alphabetical (deterministic)
    const domCmp = a.domain.localeCompare(b.domain);
    if (domCmp !== 0) return domCmp;

    // 5. original index ascending (stability: preserve input order for equals)
    return ia - ib;
  });

  return tagged.map(({ opt }) => opt);
}
