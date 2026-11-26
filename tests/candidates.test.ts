// Candidates are selected from the real manifests in corridors/, the same files
// the CLI and the engine consume. No synthetic corridors here: a match is only
// useful if it holds for what is actually configured.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCorridor, parseCorridor, type Corridor } from "@corridor/manifest";
import { candidates, SEP6_THIRD_PARTY_PAYOUT_REASON } from "@corridor/router";

const CORRIDORS_DIR = fileURLToPath(new URL("../corridors/", import.meta.url));

function realCorridors(): Corridor[] {
  const files = readdirSync(CORRIDORS_DIR).filter((file) => file.endsWith(".corridor.yaml"));
  expect(files.length).toBeGreaterThan(0);
  return files.map((file) => {
    const loaded = loadCorridor(join(CORRIDORS_DIR, file));
    if (!loaded.ok) throw new Error(`${file} failed to load: ${loaded.error.message}`);
    return loaded.value;
  });
}

const ids = (corridors: readonly Corridor[]) => corridors.map((c) => c.id);
const droppedIds = (result: { nonMatching: readonly { corridor: Corridor }[] }) =>
  ids(result.nonMatching.map((d) => d.corridor));

function find(corridors: readonly Corridor[], id: string): Corridor {
  const found = corridors.find((c) => c.id === id);
  if (!found) throw new Error(`missing real corridor: ${id}`);
  return found;
}

describe("candidates over corridors/", () => {
  it("finds every configured corridor for NGN in NG, not just any NGN lane", () => {
    const all = realCorridors();
    const result = candidates({ destAsset: "iso4217:NGN", destCountry: "NG" }, all);

    expect(ids(result.matching)).toEqual(["ng-cowrie"]);
    expect(droppedIds(result)).toEqual(ids(all.filter((c) => c.id !== "ng-cowrie")));
    const mock = result.nonMatching.find((d) => d.corridor.id === "mock");
    expect(mock?.reason).toContain("dest.asset");
    expect(mock?.reason).toContain("US");
  });

  it("requires both the asset and the country to match", () => {
    const all = realCorridors();

    const ngnInUs = candidates({ destAsset: "iso4217:NGN", destCountry: "US" }, all);
    expect(ngnInUs.matching).toEqual([]);
    expect(ngnInUs.nonMatching.find((d) => d.corridor.id === "mock")?.reason).toContain(
      "dest.asset",
    );

    // testanchor-sep6 matches on asset and country but has no third_party_payout flag (#645).
    const usdInUs = candidates({ destAsset: "iso4217:USD", destCountry: "US" }, all);
    expect(ids(usdInUs.matching)).toEqual(["mock", "reference-testnet"]);
    expect(usdInUs.nonMatching.find((d) => d.corridor.id === "ng-cowrie")?.reason).toContain(
      "NG",
    );
  });

  it("reports a reason for every non-matching corridor, in input order", () => {
    const reversed = [...realCorridors()].reverse();
    const result = candidates({ destAsset: "iso4217:XXX", destCountry: "ZZ" }, reversed);

    expect(result.matching).toEqual([]);
    expect(droppedIds(result)).toEqual(ids(reversed));
    for (const dropped of result.nonMatching) {
      expect(dropped.reason).toContain("dest.asset");
      expect(dropped.reason).toContain("dest.country");
    }
  });

  it("prefers an explicit dest.country over the legacy jurisdiction", () => {
    const mock = find(realCorridors(), "mock");
    const withCountry: Corridor = {
      ...mock,
      id: "mock-ng",
      dest: { ...mock.dest, country: "NG" },
    };

    const result = candidates({ destAsset: "iso4217:USD", destCountry: "NG" }, [
      mock,
      withCountry,
    ]);
    expect(ids(result.matching)).toEqual(["mock-ng"]);
    expect(droppedIds(result)).toEqual(["mock"]);
  });

  it("treats country codes case-insensitively", () => {
    const result = candidates(
      { destAsset: "iso4217:NGN", destCountry: "ng" },
      realCorridors(),
    );
    expect(ids(result.matching)).toEqual(["ng-cowrie"]);
  });
});

describe("SEP-6 candidates need third_party_payout (#645)", () => {
  const usdInUs = { destAsset: "iso4217:USD", destCountry: "US" };
  // Test fixture only: the real manifest records no confirmation, so the flag
  // and its note are added here to exercise the confirmed path.
  const note = "Test fixture: confirmed with the anchor (not a real confirmation)";

  function sep6(id: string, thirdPartyPayout?: boolean): Corridor {
    const real = find(realCorridors(), "testanchor-sep6");
    const dest =
      thirdPartyPayout === undefined
        ? real.dest
        : {
            ...real.dest,
            third_party_payout: thirdPartyPayout,
            ...(thirdPartyPayout ? { third_party_payout_note: note } : {}),
          };
    const parsed = parseCorridor({ ...real, id, dest });
    if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error.message}`);
    return parsed.value;
  }

  it("drops the real SEP-6 corridor, which has no flag, with a reason", () => {
    const real = find(realCorridors(), "testanchor-sep6");
    expect(real.dest.protocol).toBe("sep6");

    const result = candidates(usdInUs, [real]);
    expect(result.matching).toEqual([]);
    expect(result.nonMatching).toHaveLength(1);
    expect(result.nonMatching[0]!.corridor.id).toBe("testanchor-sep6");
    expect(result.nonMatching[0]!.reason).toBe(SEP6_THIRD_PARTY_PAYOUT_REASON);
    expect(result.nonMatching[0]!.reason).toContain("SEP-6");
    expect(result.nonMatching[0]!.reason).toContain("third_party_payout");
  });

  it("keeps a SEP-6 corridor only when third_party_payout is true", () => {
    const result = candidates(usdInUs, [sep6("confirmed", true)]);
    expect(ids(result.matching)).toEqual(["confirmed"]);
    expect(result.nonMatching).toEqual([]);
  });

  it("drops an explicit third_party_payout: false too", () => {
    const result = candidates(usdInUs, [sep6("refused", false)]);
    expect(result.matching).toEqual([]);
    expect(droppedIds(result)).toEqual(["refused"]);
    expect(result.nonMatching[0]!.reason).toBe(SEP6_THIRD_PARTY_PAYOUT_REASON);
  });

  it("leaves SEP-31 corridors, which carry no flag, unaffected", () => {
    const all = realCorridors();
    const sep31 = all.filter((c) => c.dest.protocol === "sep31");
    expect(sep31.length).toBeGreaterThan(0);

    const result = candidates(usdInUs, sep31);
    for (const dropped of result.nonMatching) {
      expect(dropped.reason).not.toContain("third_party_payout");
    }
    expect(ids(result.matching)).toEqual(["mock", "reference-testnet"]);
  });

  it("preserves order and reports every dropped SEP-6 corridor", () => {
    const mock = find(realCorridors(), "mock");
    const result = candidates(usdInUs, [sep6("a"), mock, sep6("c", true), sep6("d", false)]);

    expect(ids(result.matching)).toEqual(["mock", "c"]);
    expect(droppedIds(result)).toEqual(["a", "d"]);
  });

  it("lists the payout reason next to a destination mismatch", () => {
    const result = candidates({ destAsset: "iso4217:NGN", destCountry: "NG" }, [sep6("a")]);
    const reason = result.nonMatching[0]!.reason;
    expect(reason).toContain("dest.asset");
    expect(reason).toContain("dest.country");
    expect(reason).toContain(SEP6_THIRD_PARTY_PAYOUT_REASON);
  });
});

describe("manifest destination country", () => {
  const cowrie = find(realCorridors(), "ng-cowrie");
  const withCountry = (country: unknown) =>
    parseCorridor({ ...cowrie, dest: { ...cowrie.dest, country } });

  it("accepts an ISO 3166-1 alpha-2 code", () => {
    expect(withCountry("NG").ok).toBe(true);
  });

  it("rejects names, lowercase, alpha-3 and malformed codes", () => {
    for (const bad of ["Nigeria", "ng", "NGN", "N1", "", " NG"]) {
      expect(withCountry(bad).ok, String(bad)).toBe(false);
    }
  });

  it("keeps existing manifests, which have no explicit dest.country, loadable", () => {
    expect(parseCorridor(cowrie).ok).toBe(true);
  });
});
