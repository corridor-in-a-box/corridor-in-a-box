import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { rank, type RankableOption } from "@corridor/router";

function option(overrides: Partial<RankableOption>): RankableOption {
  return {
    domain: "a.example",
    label: "locked",
    cautiousDestAmount: "100.00",
    reliability: 0.9,
    estimatedDeliveryMs: 1000,
    ...overrides,
  };
}

describe("rank() — RFC 0004", () => {
  describe("primary sort: cautiousDestAmount descending", () => {
    it("ranks higher recipient amount first", () => {
      const input = [
        option({ cautiousDestAmount: "50.00", domain: "c.example" }),
        option({ cautiousDestAmount: "200.00", domain: "b.example" }),
        option({ cautiousDestAmount: "100.00", domain: "a.example" }),
      ];
      const ranked = rank(input);
      expect(ranked.map((o) => o.cautiousDestAmount)).toEqual(["200.00", "100.00", "50.00"]);
      expect(ranked.map((o) => o.domain)).toEqual(["b.example", "a.example", "c.example"]);
    });

    it("compares decimal strings as scaled values, not floats", () => {
      const input = [
        option({ cautiousDestAmount: "100.10", domain: "b.example" }),
        option({ cautiousDestAmount: "100.09", domain: "a.example" }),
      ];
      expect(rank(input).map((o) => o.domain)).toEqual(["b.example", "a.example"]);
    });

    it("handles sub-stroop precision up to the type scale", () => {
      const input = [
        option({ cautiousDestAmount: "0.0000001", domain: "a.example" }),
        option({ cautiousDestAmount: "0", domain: "b.example" }),
      ];
      expect(rank(input).map((o) => o.domain)).toEqual(["a.example", "b.example"]);
    });
  });

  describe("every label from RFC 0004", () => {
    it("ranks locked / indicative / estimated by the pre-computed cautious amount", () => {
      // rank() receives already-cautious amounts; the label only documents how
      // the caller computed them. Same amount, different labels: any order is
      // valid, so use distinct amounts to assert label doesn't re-rank.
      const input = [
        option({
          label: "estimated",
          cautiousDestAmount: "70.00",
          domain: "estimated.example",
        }),
        option({ label: "locked", cautiousDestAmount: "90.00", domain: "locked.example" }),
        option({
          label: "indicative",
          cautiousDestAmount: "80.00",
          domain: "indicative.example",
        }),
      ];
      expect(rank(input).map((o) => o.domain)).toEqual([
        "locked.example",
        "indicative.example",
        "estimated.example",
      ]);
    });

    it("treats each label identically — no per-label discount inside rank()", () => {
      const base = {
        cautiousDestAmount: "100.00",
        reliability: 0.8,
        estimatedDeliveryMs: 500,
      };
      const input = [
        option({ ...base, label: "locked", domain: "same.example" }),
        option({ ...base, label: "indicative", domain: "same.example" }),
        option({ ...base, label: "estimated", domain: "same.example" }),
      ];
      // Everything equal on every sort key → label does not re-rank; input order preserved.
      expect(rank(input).map((o) => o.domain)).toEqual([
        "same.example",
        "same.example",
        "same.example",
      ]);
      expect(rank(input).map((o) => o.label)).toEqual(["locked", "indicative", "estimated"]);
    });
  });

  describe("tie-break 2: reliability descending (higher is better)", () => {
    it("prefers the more reliable anchor on equal amounts", () => {
      const input = [
        option({ reliability: 0.6, domain: "mid.example" }),
        option({ reliability: 0.9, domain: "high.example" }),
      ];
      expect(rank(input).map((o) => o.domain)).toEqual(["high.example", "mid.example"]);
    });

    it("treats undefined reliability as 0.5", () => {
      const input = [
        option({ reliability: undefined, domain: "unknown.example" }),
        option({ reliability: 0.9, domain: "high.example" }),
        option({ reliability: 0.1, domain: "low.example" }),
      ];
      expect(rank(input).map((o) => o.domain)).toEqual([
        "high.example",
        "unknown.example",
        "low.example",
      ]);
    });
  });

  describe("tie-break 3: estimatedDeliveryMs ascending (lower/faster is better)", () => {
    it("prefers the faster anchor on equal amounts and reliability", () => {
      const input = [
        option({ estimatedDeliveryMs: 2000, domain: "slow.example" }),
        option({ estimatedDeliveryMs: 500, domain: "fast.example" }),
      ];
      expect(rank(input).map((o) => o.domain)).toEqual(["fast.example", "slow.example"]);
    });

    it("treats undefined estimatedDeliveryMs as Infinity (slowest)", () => {
      const input = [
        option({ estimatedDeliveryMs: undefined, domain: "unknown.example" }),
        option({ estimatedDeliveryMs: 500, domain: "fast.example" }),
      ];
      expect(rank(input).map((o) => o.domain)).toEqual(["fast.example", "unknown.example"]);
    });
  });

  describe("tie-break 4: domain ascending alphabetical", () => {
    it("orders equal options by domain ascending", () => {
      const input = [
        option({ domain: "z.example" }),
        option({ domain: "a.example" }),
        option({ domain: "m.example" }),
      ];
      expect(rank(input).map((o) => o.domain)).toEqual([
        "a.example",
        "m.example",
        "z.example",
      ]);
    });
  });

  describe("mixed criteria", () => {
    it("never lets a weaker key override a stronger one", () => {
      const input = [
        option({
          cautiousDestAmount: "99.00",
          reliability: 0.99,
          estimatedDeliveryMs: 100,
          domain: "z.example",
        }),
        option({
          cautiousDestAmount: "100.00",
          reliability: 0.01,
          estimatedDeliveryMs: 900000,
          domain: "a.example",
        }),
      ];
      // Amount dominates despite worse reliability, speed, and domain.
      expect(rank(input).map((o) => o.domain)).toEqual(["a.example", "z.example"]);
    });
  });

  describe("purity", () => {
    it("returns a new array and never mutates the input", () => {
      const first = option({ cautiousDestAmount: "50.00" });
      const second = option({ cautiousDestAmount: "100.00" });
      const input = [first, second];
      const inputBefore = [...input];

      const result = rank(input);

      expect(result).not.toBe(input); // new array instance
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(second); // same object references, reordered
      expect(result[1]).toBe(first);
      expect(input).toEqual(inputBefore); // input untouched: order and references
    });

    it("returns a new empty array for an empty input", () => {
      const result = rank([]);
      expect(result).toEqual([]);
      expect(result).not.toBe([]);
    });

    it("returns a new single-element array", () => {
      const input = [option({ cautiousDestAmount: "7.00" })];
      const result = rank(input);
      expect(result).toHaveLength(1);
      expect(result).not.toBe(input);
      expect(result[0]).toBe(input[0]);
    });
  });

  describe("stability", () => {
    it("preserves input order for options equal on every criterion", () => {
      const tied = [
        option({ domain: "same.example" }),
        option({ domain: "same.example" }),
        option({ domain: "same.example" }),
      ];
      expect(rank(tied)).toEqual(tied);
    });
  });
});

// --- property-based tests ---------------------------------------------------

const amountArb = fc.integer({ min: 0, max: 1_000_000_000 }).map((n) => String(n));

const optionArb = fc.record({
  domain: fc.string({ minLength: 1, maxLength: 32 }),
  label: fc.constantFrom("locked", "indicative", "estimated"),
  cautiousDestAmount: amountArb,
  reliability: fc
    .option(fc.float({ min: 0, max: 1 }))
    .map((v) => (v === null ? undefined : v)),
  estimatedDeliveryMs: fc
    .option(fc.integer({ min: 0, max: 10_000 }))
    .map((v) => (v === null ? undefined : v)),
});

const optionsArb = fc.array(optionArb, { minLength: 0, maxLength: 40 });

/** True when `output` is a permutation of `input` (same elements by reference). */
function isPermutation<T>(input: readonly T[], output: readonly T[]): boolean {
  if (input.length !== output.length) return false;
  const consumed = output.map(() => false);
  for (const x of input) {
    const i = consumed.findIndex((used, j) => !used && output[j] === x);
    if (i === -1) return false;
    consumed[i] = true;
  }
  return true;
}

describe("rank() — properties (fast-check)", () => {
  it("always returns a permutation of the input", () => {
    fc.assert(
      fc.property(optionsArb, (options) => {
        const snapshot = [...options];
        const result = rank(options);
        expect(isPermutation(snapshot, result)).toBe(true);
        // input not mutated
        expect(options).toEqual(snapshot);
      }),
      { numRuns: 250 },
    );
  });

  it("preserves relative order for fully tied inputs (stability)", () => {
    const tiedArb = fc
      .record({
        domain: fc.string({ minLength: 1, maxLength: 16 }),
        cautiousDestAmount: amountArb,
        reliability: fc.option(fc.float({ min: 0, max: 1 })),
        estimatedDeliveryMs: fc.option(fc.integer({ min: 0, max: 10_000 })),
        labels: fc.array(fc.constantFrom("locked", "indicative", "estimated"), {
          minLength: 1,
          maxLength: 8,
        }),
      })
      .map(({ domain, cautiousDestAmount, reliability, estimatedDeliveryMs, labels }) =>
        labels.map(
          (label) =>
            ({
              domain,
              label,
              cautiousDestAmount,
              reliability,
              estimatedDeliveryMs,
            }) as RankableOption,
        ),
      );

    fc.assert(
      fc.property(tiedArb, (options) => {
        expect(rank(options)).toEqual(options);
      }),
      { numRuns: 250 },
    );
  });
});
