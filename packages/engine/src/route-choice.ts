// Turns a RouteDecision into the record the audit trail keeps about it, so
// "why did this payment go through anchor X?" has an answer in the
// append-only trail rather than only in a resolver's logs.
//
// Bounded on purpose: a third-party resolver controls these strings, and the
// trail is append-only, so at most three options, five reasons each, and 200
// characters per string are kept.

import type { RouteDecision } from "@corridor/router";
import type { RouteChoice, RouteChoiceOption } from "./observability";

/** How many options the trail keeps. */
export const ROUTE_CHOICE_TOP_N = 3;
const MAX_REASONS = 5;
const MAX_TEXT = 200;

function text(value: unknown): string {
  const s = typeof value === "string" ? value : String(value);
  return s.length <= MAX_TEXT ? s : `${s.slice(0, MAX_TEXT - 1)}…`;
}

function rankOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/**
 * The audit record for a route decision.
 *
 * With a `ranking`, the chosen option is the one whose id matches
 * `ranking.chosen`, and `top` is the best three by rank (ties keep the
 * resolver's order). Without one — or when the chosen id is not among the
 * options — the receiving adapter is recorded as the single, rank-1 option.
 */
export function routeChoiceFor(decision: RouteDecision): RouteChoice {
  const options = decision.ranking?.options ?? [];
  const chosen = options.find((o) => o.id === decision.ranking?.chosen);

  if (!chosen) {
    const name = text(decision.receiving.name);
    const only: RouteChoiceOption = {
      id: name,
      label: name,
      rank: 1,
      reasons: [`single option from resolver (trust: ${decision.trust})`],
    };
    return { chosen: { id: only.id, label: only.label, rank: 1 }, top: [only] };
  }

  const top = options
    .map((o, i) => ({ o, i }))
    .sort((a, b) => rankOf(a.o.rank) - rankOf(b.o.rank) || a.i - b.i)
    .slice(0, ROUTE_CHOICE_TOP_N)
    .map(({ o }) => ({
      id: text(o.id),
      label: text(o.label),
      rank: rankOf(o.rank),
      reasons: (Array.isArray(o.reasons) ? o.reasons : []).slice(0, MAX_REASONS).map(text),
    }));

  return {
    chosen: { id: text(chosen.id), label: text(chosen.label), rank: rankOf(chosen.rank) },
    top,
  };
}
