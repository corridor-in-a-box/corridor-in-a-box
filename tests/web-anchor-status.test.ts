import { describe, expect, it } from "vitest";
import {
  NO_TOML_HASH,
  canJudgeSep31,
  displayTomlHash,
  isZeroHash,
  sepSummary,
  sortAnchorsForDisplay,
  tomlStatus,
  type AnchorLike,
} from "../web/lib/anchor-status";

const ZERO = "0".repeat(64);
const HASH = "ab".repeat(32);
const ALL = ["toml_fetch", "sep10_auth", "sep31_info"];

const anchor = (over: Partial<AnchorLike> = {}): AnchorLike => ({
  domain: "example.com",
  seps: [],
  probesRun: ALL,
  probesPassed: ["toml_fetch"],
  tomlHash: HASH,
  servesSep31: false,
  ...over,
});

// The shape the live registry holds for e.g. bitso.com: toml_fetch ran and failed,
// nothing advertised, and the hash left as zeros.
const unreachable = anchor({ domain: "bitso.com", probesPassed: [], tomlHash: ZERO });

describe("tomlStatus", () => {
  it("tells a read toml from an unreachable one and from one never probed", () => {
    expect(tomlStatus(anchor())).toBe("read");
    expect(tomlStatus(unreachable)).toBe("unreachable");
    expect(tomlStatus(anchor({ probesRun: [], probesPassed: [] }))).toBe("not-probed");
  });
});

describe("sepSummary", () => {
  it("never says 'no SEP endpoints' when the toml could not be fetched", () => {
    expect(sepSummary(unreachable)).toBe("stellar.toml unreachable from the probe");
    expect(sepSummary(unreachable)).not.toMatch(/no SEP/);
    expect(sepSummary(anchor({ probesRun: [], probesPassed: [] }))).toBe(
      "stellar.toml not probed",
    );
  });

  it("still says 'no SEP endpoints' when the toml was read and advertises none", () => {
    expect(sepSummary(anchor())).toBe("no SEP endpoints");
  });

  it("lists what a read toml advertises", () => {
    expect(sepSummary(anchor({ seps: [10, 31] }))).toBe("SEP-10 · SEP-31");
  });
});

describe("canJudgeSep31", () => {
  it("gives no SEP-31 verdict without the toml", () => {
    expect(canJudgeSep31(unreachable)).toBe(false);
  });

  it("gives one when the toml was read, whichever way it goes", () => {
    expect(canJudgeSep31(anchor())).toBe(true);
    expect(canJudgeSep31(anchor({ seps: [31], servesSep31: true }))).toBe(true);
  });
});

describe("displayTomlHash", () => {
  it("hides the all-zero placeholder when the toml was never fetched", () => {
    expect(displayTomlHash(unreachable)).toBeUndefined();
  });

  it("never shows an all-zero hash as if it were real", () => {
    expect(displayTomlHash(anchor({ tomlHash: ZERO }))).toBeUndefined();
    expect(isZeroHash(ZERO)).toBe(true);
    expect(isZeroHash(HASH)).toBe(false);
  });

  it("shows a real hash of a fetched toml", () => {
    expect(displayTomlHash(anchor())).toBe(HASH);
  });

  it("has a neutral placeholder to show instead", () => {
    expect(NO_TOML_HASH).toBe("—");
  });
});

describe("sortAnchorsForDisplay", () => {
  it("puts anchors with a read toml first and keeps order within each group", () => {
    const a = anchor({ domain: "a.com" });
    const b = { ...unreachable, domain: "b.com" };
    const c = anchor({ domain: "c.com" });
    const d = { ...unreachable, domain: "d.com" };
    const sorted = sortAnchorsForDisplay([a, b, c, d]).map((x) => x.domain);
    expect(sorted).toEqual(["a.com", "c.com", "b.com", "d.com"]);
  });

  it("does not mutate its input", () => {
    const input = [unreachable, anchor()];
    sortAnchorsForDisplay(input);
    expect(input[0]).toBe(unreachable);
  });
});
