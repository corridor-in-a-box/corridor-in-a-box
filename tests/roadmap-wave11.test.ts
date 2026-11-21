import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The roadmap's wave-11 plan is an index of issues, and an index is only worth having
// if it is complete and its links go somewhere. This holds it to the rule it was added
// under: every roadmap item links to an issue. It says nothing about whether an issue
// is still open; ticking an item off is a person's job.

const repo = (path: string) => resolve(process.cwd(), path);
const roadmap = readFileSync(repo("ROADMAP.md"), "utf8").replace(/\r\n/g, "\n");

const WAVE_HEADING = "## Wave 11 — the smart router and the road to mainnet";
const ISSUE_REFERENCE = /\[#(\d+)\]/g;
const LINK_DEFINITION = /^\[#(\d+)\]: (\S+)$/gm;

/** The wave-11 section, without the link definitions that follow it. */
function waveSection(): string {
  const start = roadmap.indexOf(`\n${WAVE_HEADING}\n`);
  if (start === -1) return "";
  const rest = roadmap.slice(start + WAVE_HEADING.length + 2);
  const end = rest.search(/^\[#\d+\]: /m);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Every list item of a piece of markdown, with its continuation lines joined on. */
function items(markdown: string): string[] {
  const out: string[] = [];
  for (const line of markdown.split("\n")) {
    if (line.startsWith("- ")) out.push(line);
    else if (line.startsWith("  ") && out.length > 0) out[out.length - 1] += ` ${line.trim()}`;
  }
  return out;
}

const issuesIn = (text: string): number[] =>
  [...text.matchAll(ISSUE_REFERENCE)].map((m) => Number(m[1]));

/** The issues wave 11 opened, #589 to #708, and the seven older ones it carried in. */
const WAVE_ISSUES = [
  223,
  266,
  267,
  584,
  585,
  586,
  587,
  ...Array.from({ length: 708 - 589 + 1 }, (_, i) => 589 + i),
];

/**
 * Open items that link neither an issue nor an RFC, on purpose: each is a maintainer's
 * own action that the tracker has no issue for. Adding one here needs a reason.
 */
const WITHOUT_AN_ISSUE = ["SCF Tier-2 grant proposal"];

describe("ROADMAP: the wave-11 plan", () => {
  it("has the plan, with the workstreams the wave is made of", () => {
    expect(roadmap, "the wave-11 section is missing from ROADMAP.md").toContain(
      `\n${WAVE_HEADING}\n`,
    );
    const workstreams = [...waveSection().matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    expect(workstreams).toEqual([
      "Smart router",
      "Rate history",
      "Lane checks",
      "Onboarding",
      "More anchors and route types",
      "Proof on testnet",
      "Mainnet steps",
    ]);
  });

  it("links every item of the plan to at least one issue", () => {
    const planned = items(waveSection());
    expect(planned.length).toBeGreaterThan(20);
    for (const item of planned) {
      expect(item.startsWith("- ⬜ ") || item.startsWith("- ✅ "), item.slice(0, 50)).toBe(
        true,
      );
      expect(issuesIn(item).length, `no issue on: ${item.slice(0, 70)}`).toBeGreaterThan(0);
    }
    // And no workstream is a heading with nothing under it.
    for (const block of waveSection()
      .split(/^### .+$/m)
      .slice(1)) {
      expect(items(block).length).toBeGreaterThan(0);
    }
  });

  it("covers every issue of the wave, each one once", () => {
    const cited = issuesIn(waveSection());
    expect(WAVE_ISSUES).toHaveLength(127);
    expect([...cited].sort((a, b) => a - b)).toEqual([...WAVE_ISSUES].sort((a, b) => a - b));
  });

  it("links every open item on the roadmap to an issue or an RFC", () => {
    const open = items(roadmap).filter((item) => item.startsWith("- ⬜ "));
    expect(open.length).toBeGreaterThan(25);

    const without = open.filter(
      (item) => issuesIn(item).length === 0 && !/\]\(\.\/docs\/rfcs\/[^)]+\)/.test(item),
    );
    // The exceptions are named, so a new open item cannot join them unnoticed.
    expect(
      without.map(
        (item) =>
          WITHOUT_AN_ISSUE.find((name) => item.startsWith(`- ⬜ ${name}`)) ??
          item.slice(0, 70),
      ),
    ).toEqual(WITHOUT_AN_ISSUE);
  });

  it("links only files that are in the repository", () => {
    const targets = [...roadmap.matchAll(/\]\(\.\/([^)#]+)\)/g)].map((m) => m[1]!);
    // Enough of them that an empty match would be a broken pattern, not a clean file.
    expect(targets.length).toBeGreaterThan(2);
    for (const path of targets) {
      expect(existsSync(repo(path)), `${path} does not exist`).toBe(true);
    }
  });

  it("defines a link for every issue it names, and none it does not use", () => {
    const prose = roadmap.replace(LINK_DEFINITION, "");
    const used = new Set(issuesIn(prose));
    const defined = new Map(
      [...roadmap.matchAll(LINK_DEFINITION)].map((m) => [Number(m[1]), m[2]!] as const),
    );

    expect(used.size).toBe(127);
    for (const n of used) {
      expect(defined.get(n), `[#${n}] is used but has no link`).toBe(
        `https://github.com/corridor-in-a-box/corridor-in-a-box/issues/${n}`,
      );
    }
    for (const n of defined.keys()) {
      expect(used.has(n), `[#${n}] is defined but never used`).toBe(true);
    }
  });

  it("does not link the RFC until it is in the repository", () => {
    // The plan names RFC 0004 as its design reference. Four open PRs each add a
    // different file under that name; a link before one of them merges is a dead link.
    const linked = /\]\(\.?\/?docs\/rfcs\/0004[^)]*\)/.test(roadmap);
    if (!existsSync(repo("docs/rfcs/0004-smart-router.md"))) {
      expect(linked, "ROADMAP.md links an RFC file that is not in the repository").toBe(false);
    }
    expect(waveSection()).toContain("RFC 0004");
  });
});
