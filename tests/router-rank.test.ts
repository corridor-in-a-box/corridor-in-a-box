// rank() — RFC 0004 §1 "Ranking", issue #611.
//
// Example tests per label and per tie-break, then property tests with the
// repo's seeded-generator pattern (see tests/money-properties.test.ts): no
// property-testing dependency, reproducible runs, and a failure names its seed
// and input.

import { describe, expect, it } from "vitest";
import { compareAmounts, STROOP_SCALE } from "@corridor/types";
import {
  cautiousRecipientAmount,
  rank,
  type PriceLabel,
  type RankableOption,
  type RouteOption,
} from "@corridor/router";

interface Opt extends RankableOption {
  readonly price: { readonly label: PriceLabel };
}

function option(
  overrides: {
    domain?: string;
    label?: PriceLabel;
    amount?: string;
    asset?: string;
    reliability?: number;
    estimatedDeliveryMs?: number | undefined;
  } = {},
): Opt {
  const base: Opt = {
    receivingDomain: overrides.domain ?? "a.example",
    price: { label: overrides.label ?? "locked" },
    recipientGets: {
      asset: overrides.asset ?? "iso4217:NGN",
      amount: overrides.amount ?? "100",
    },
    reliability: overrides.reliability ?? 0.9,
  };
  const ms = "estimatedDeliveryMs" in overrides ? overrides.estimatedDeliveryMs : 1000;
  return ms === undefined ? base : { ...base, estimatedDeliveryMs: ms };
}

const domains = (opts: readonly RankableOption[]) => opts.map((o) => o.receivingDomain);

describe("rank() — cautious amount per label (RFC 0004 D3)", () => {
  it("takes a locked amount as quoted", () => {
    expect(cautiousRecipientAmount(option({ label: "locked", amount: "100" }))).toBe("100");
    expect(cautiousRecipientAmount(option({ label: "locked", amount: "100" }), 500)).toBe(
      "100",
    );
  });

  it("takes the default 50 bps margin off an indicative amount", () => {
    expect(cautiousRecipientAmount(option({ label: "indicative", amount: "100" }))).toBe(
      "99.5",
    );
  });

  it("takes the default 50 bps margin off an estimated (P25) amount", () => {
    expect(cautiousRecipientAmount(option({ label: "estimated", amount: "1000" }))).toBe(
      "995",
    );
  });

  it("uses the margin it is given", () => {
    expect(cautiousRecipientAmount(option({ label: "indicative", amount: "100" }), 200)).toBe(
      "98",
    );
    expect(cautiousRecipientAmount(option({ label: "estimated", amount: "100" }), 0)).toBe(
      "100",
    );
  });

  it("ranks a locked amount above a slightly higher indicative one", () => {
    // indicative 100 → 99.5 after the margin, below locked 99.6.
    const ranked = rank([
      option({ label: "indicative", amount: "100", domain: "indicative.example" }),
      option({ label: "locked", amount: "99.6", domain: "locked.example" }),
    ]);
    expect(domains(ranked)).toEqual(["locked.example", "indicative.example"]);
  });

  it("ranks an indicative amount first once its margin no longer covers the gap", () => {
    // indicative 100.2 → 99.699 after the margin, above locked 99.6.
    const ranked = rank([
      option({ label: "locked", amount: "99.6", domain: "locked.example" }),
      option({ label: "indicative", amount: "100.2", domain: "indicative.example" }),
    ]);
    expect(domains(ranked)).toEqual(["indicative.example", "locked.example"]);
  });

  it("ranks a locked amount above a slightly higher estimated one", () => {
    // estimated 100.4 → 99.898 after the margin, below locked 99.9.
    const ranked = rank([
      option({ label: "estimated", amount: "100.4", domain: "estimated.example" }),
      option({ label: "locked", amount: "99.9", domain: "locked.example" }),
    ]);
    expect(domains(ranked)).toEqual(["locked.example", "estimated.example"]);
  });

  it("ranks a locked amount first when every label shows the same amount", () => {
    const ranked = rank([
      option({
        label: "estimated",
        amount: "100",
        domain: "estimated.example",
        reliability: 0.5,
      }),
      option({
        label: "indicative",
        amount: "100",
        domain: "indicative.example",
        reliability: 0.6,
      }),
      option({ label: "locked", amount: "100", domain: "locked.example", reliability: 0.1 }),
    ]);
    // locked keeps 100; the other two drop to 99.5 and tie, so reliability decides.
    expect(domains(ranked)).toEqual([
      "locked.example",
      "indicative.example",
      "estimated.example",
    ]);
  });

  it("changes the order when the margin changes", () => {
    const input = [
      option({ label: "locked", amount: "99.97", domain: "locked.example" }),
      option({ label: "indicative", amount: "102", domain: "indicative.example" }),
    ];
    // 50 bps: 102 → 101.49, above 99.97.
    expect(domains(rank(input))).toEqual(["indicative.example", "locked.example"]);
    // 200 bps: 102 → 99.96, below 99.97.
    expect(domains(rank(input, { estimateMarginBps: 200 }))).toEqual([
      "locked.example",
      "indicative.example",
    ]);
    // 0 bps: labels no longer matter, 102 wins.
    expect(domains(rank(input, { estimateMarginBps: 0 }))).toEqual([
      "indicative.example",
      "locked.example",
    ]);
  });

  it("compares amounts as decimals, not floats", () => {
    const ranked = rank([
      option({ amount: "100.09", domain: "a.example" }),
      option({ amount: "100.1", domain: "b.example" }),
      option({ amount: "0.0000001", domain: "c.example" }),
      option({ amount: "0", domain: "d.example" }),
    ]);
    expect(domains(ranked)).toEqual(["b.example", "a.example", "c.example", "d.example"]);
  });
});

describe("rank() — tie-breaks", () => {
  it("prefers the more reliable anchor on equal cautious amounts", () => {
    const ranked = rank([
      option({ reliability: 0.6, domain: "mid.example" }),
      option({ reliability: 0.9, domain: "high.example" }),
    ]);
    expect(domains(ranked)).toEqual(["high.example", "mid.example"]);
  });

  it("prefers the faster anchor on equal amount and reliability", () => {
    const ranked = rank([
      option({ estimatedDeliveryMs: 2000, domain: "slow.example" }),
      option({ estimatedDeliveryMs: 500, domain: "fast.example" }),
    ]);
    expect(domains(ranked)).toEqual(["fast.example", "slow.example"]);
  });

  it("puts an unknown delivery time behind any known one", () => {
    const ranked = rank([
      option({ estimatedDeliveryMs: undefined, domain: "a.example" }),
      option({ estimatedDeliveryMs: 900_000, domain: "z.example" }),
    ]);
    expect(domains(ranked)).toEqual(["z.example", "a.example"]);
  });

  it("orders the rest by domain, by code unit, not by locale", () => {
    // localeCompare would put "a.example" before "B.example"; code units put
    // uppercase first, the same on every runtime.
    const ranked = rank([
      option({ domain: "b.example" }),
      option({ domain: "a.example" }),
      option({ domain: "B.example" }),
      option({ domain: "ä.example" }),
    ]);
    expect(domains(ranked)).toEqual(["B.example", "a.example", "b.example", "ä.example"]);
  });

  it("never lets a weaker key override a stronger one", () => {
    const ranked = rank([
      option({
        amount: "99",
        reliability: 0.99,
        estimatedDeliveryMs: 100,
        domain: "a.example",
      }),
      option({
        amount: "100",
        reliability: 0.01,
        estimatedDeliveryMs: 900_000,
        domain: "z.example",
      }),
    ]);
    expect(domains(ranked)).toEqual(["z.example", "a.example"]);
  });
});

describe("rank() — purity and input checks", () => {
  it("returns a new array of the same objects and leaves the input alone", () => {
    const first = option({ amount: "50" });
    const second = option({ amount: "100" });
    const input = [first, second];
    const result = rank(input);
    expect(result).not.toBe(input);
    expect(result[0]).toBe(second);
    expect(result[1]).toBe(first);
    expect(input).toEqual([first, second]);
    expect(input[0]).toBe(first);
  });

  it("returns a new empty array for no options", () => {
    const input: Opt[] = [];
    const result = rank(input);
    expect(result).toEqual([]);
    expect(result).not.toBe(input);
  });

  it("ranks full RouteOption values", () => {
    const route = (
      receivingDomain: string,
      label: PriceLabel,
      amount: string,
    ): RouteOption => ({
      corridorId: "usdc-ngn",
      receivingDomain,
      protocol: "sep31",
      price: { label, rate: "1500" },
      recipientGets: { asset: "iso4217:NGN", amount },
      fees: { asset: "iso4217:NGN", amount: "0" },
      reliability: 0.95,
      reasons: [],
    });
    const ranked: RouteOption[] = rank([
      route("estimated.example", "estimated", "150500"),
      route("locked.example", "locked", "150000"),
    ]);
    // 150500 minus 50 bps is 149747.5, below the locked 150000.
    expect(domains(ranked)).toEqual(["locked.example", "estimated.example"]);
  });

  it.each([
    ["a malformed amount", [option({ amount: "1e3" })], {}],
    ["more places than a stroop", [option({ amount: "1.12345678" })], {}],
    ["a negative amount", [option({ amount: "-1" })], {}],
    ["a reliability above 1", [option({ reliability: 1.5 })], {}],
    ["a NaN reliability", [option({ reliability: Number.NaN })], {}],
    ["a negative delivery time", [option({ estimatedDeliveryMs: -1 })], {}],
    [
      "mixed assets",
      [
        option({ asset: "iso4217:NGN" }),
        option({ asset: "iso4217:KES", domain: "b.example" }),
      ],
      {},
    ],
    ["a fractional margin", [option()], { estimateMarginBps: 12.5 }],
    ["a margin of 100%", [option()], { estimateMarginBps: 10_000 }],
    ["a negative margin", [], { estimateMarginBps: -1 }],
  ] as const)("throws a RangeError for %s", (_name, input, settings) => {
    expect(() => rank(input, settings)).toThrow(RangeError);
  });

  it("throws for an unknown label", () => {
    const bad = { ...option(), price: { label: "guessed" as PriceLabel } };
    expect(() => rank([bad])).toThrow(RangeError);
  });
});

// --- properties ---------------------------------------------------------------

/** Deterministic PRNG (mulberry32), as in tests/money-properties.test.ts. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RUNS = 300;
const LABELS: readonly PriceLabel[] = ["locked", "indicative", "estimated"];
// A small pool so equal keys (and full ties) actually occur.
const DOMAINS = ["a.example", "b.example", "B.example", "z.example", "ä.example"];
const AMOUNTS = ["0", "99.5", "100", "100.5", "1500.1234567"];

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)]!;
}

/** A non-negative decimal with up to 7 places, sometimes from a small pool to force ties. */
function amount(r: () => number): string {
  if (r() < 0.4) return pick(r, AMOUNTS);
  const int = Math.floor(r() * 10 ** Math.floor(r() * 10)).toString();
  const places = Math.floor(r() * (STROOP_SCALE + 1));
  const frac =
    places === 0
      ? ""
      : "." + Array.from({ length: places }, () => Math.floor(r() * 10)).join("");
  return `${int}${frac}`;
}

function randomOption(r: () => number): Opt {
  return option({
    domain: pick(r, DOMAINS),
    label: pick(r, LABELS),
    amount: amount(r),
    reliability: Math.floor(r() * 5) / 4,
    estimatedDeliveryMs: r() < 0.3 ? undefined : Math.floor(r() * 4) * 1000,
  });
}

function randomOptions(r: () => number, max = 25): Opt[] {
  return Array.from({ length: Math.floor(r() * (max + 1)) }, () => randomOption(r));
}

function shuffled<T>(r: () => number, xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** True when `out` holds exactly the objects of `input`, each once. */
function isPermutation<T>(input: readonly T[], out: readonly T[]): boolean {
  if (input.length !== out.length) return false;
  const used = out.map(() => false);
  return input.every((x) => {
    const i = out.findIndex((y, j) => !used[j] && y === x);
    if (i === -1) return false;
    used[i] = true;
    return true;
  });
}

/** Ranking key with the input position dropped: two options with equal keys are "equal inputs". */
function key(o: Opt): string {
  return [
    cautiousRecipientAmount(o),
    o.reliability,
    o.estimatedDeliveryMs ?? "unknown",
    o.receivingDomain,
  ].join("|");
}

const describeInput = (seed: number, input: readonly Opt[]) =>
  `seed ${seed}: ${JSON.stringify(input)}`;

describe("rank() — properties", () => {
  it("returns a permutation of its input and never mutates it", () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const r = rng(seed);
      const input = randomOptions(r);
      const before = [...input];
      const out = rank(input);
      expect(isPermutation(before, out), describeInput(seed, before)).toBe(true);
      expect(input, describeInput(seed, before)).toEqual(before);
      expect(
        input.every((o, i) => o === before[i]),
        describeInput(seed, before),
      ).toBe(true);
    }
  });

  it("orders by cautious amount, then reliability, then speed, then domain", () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const r = rng(0x5eed0000 + seed);
      const input = randomOptions(r);
      const out = rank(input);
      for (let i = 1; i < out.length; i++) {
        const [a, b] = [out[i - 1]!, out[i]!];
        const msg = `${describeInput(seed, input)} at ${i}`;
        const byAmount = compareAmounts(
          cautiousRecipientAmount(a),
          cautiousRecipientAmount(b),
        );
        expect(byAmount.ok && byAmount.value >= 0, msg).toBe(true);
        if (byAmount.ok && byAmount.value > 0) continue;
        expect(a.reliability >= b.reliability, msg).toBe(true);
        if (a.reliability > b.reliability) continue;
        const msA = a.estimatedDeliveryMs ?? Number.POSITIVE_INFINITY;
        const msB = b.estimatedDeliveryMs ?? Number.POSITIVE_INFINITY;
        expect(msA <= msB, msg).toBe(true);
        if (msA < msB) continue;
        expect(a.receivingDomain <= b.receivingDomain, msg).toBe(true);
      }
    }
  });

  it("is stable: equal inputs keep their input order", () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const r = rng(0xab1e0000 + seed);
      const input = randomOptions(r, 30);
      const out = rank(input);
      const groups = new Map<string, Opt[]>();
      for (const o of out) groups.set(key(o), [...(groups.get(key(o)) ?? []), o]);
      for (const [k, group] of groups) {
        const inInputOrder = input.filter((o) => key(o) === k);
        expect(group, `${describeInput(seed, input)} key ${k}`).toEqual(inInputOrder);
        expect(group.every((o, i) => o === inInputOrder[i])).toBe(true);
      }
    }
  });

  it("gives the same order of keys however the input is shuffled", () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const r = rng(0xd1ce0000 + seed);
      const input = randomOptions(r);
      const expected = rank(input).map(key);
      const again = rank(shuffled(r, input)).map(key);
      expect(again, describeInput(seed, input)).toEqual(expected);
    }
  });

  it("keeps a run of fully tied options in input order", () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const r = rng(0x71ed0000 + seed);
      const shared = {
        domain: pick(r, DOMAINS),
        amount: amount(r),
        reliability: Math.floor(r() * 5) / 4,
        estimatedDeliveryMs: Math.floor(r() * 4) * 1000,
      };
      // indicative and estimated share a margin, so they tie with each other.
      const tied = Array.from({ length: 1 + Math.floor(r() * 8) }, () =>
        option({ ...shared, label: r() < 0.5 ? "indicative" : "estimated" }),
      );
      const out = rank(tied);
      expect(
        out.every((o, i) => o === tied[i]),
        describeInput(seed, tied),
      ).toBe(true);
    }
  });
});
