import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryIdempotencyStore } from "@corridor/engine";
import type { BreakerRecord, RunResult, SettlementRequest } from "@corridor/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { liveness, loadCorridor, parseCorridor, type Corridor } from "@corridor/manifest";
import { ok } from "@corridor/types";
import type { SettlementFacts } from "@corridor/stellar";
import { finalizeCanary, type PaymentVerifier } from "../packages/cli/src/proof";
import {
  listHeldRuns,
  parseListArgs,
  parseResolveArgs,
  resolveHeldRun,
} from "../packages/cli/src/runs";
import {
  currentUser,
  formatBreakerRecord,
  formatBreakerReset,
  formatBreakerTable,
  parseBreakerArgs,
} from "../packages/cli/src/breaker";
import {
  compareManifestToToml,
  formatLintResult,
  isPlaceholderDomain,
  lintCorridor,
} from "../packages/cli/src/lint";
import {
  formatRoutes,
  parseRoutesArgs,
  planCliRoutes,
  rateHistoryFrom,
  registryFor,
  toDestAsset,
  type RoutesArgs,
} from "../packages/cli/src/routes";
import type { AttestationSource } from "@corridor/router";

// packages/cli/src/index.ts calls process.exit(main(...)) at module top level
// and has no vitest path alias, so importing it directly would kill the test
// worker. Spawn it as a child process instead — also a more honest way to
// test a CLI's actual argv/exit-code/stdio contract. Everything that does not
// need a process (argument parsing, rendering) lives in packages/cli/src/breaker
// and is imported directly below, because the interesting properties of those
// are types and strings, not exit codes.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
// Spawn `node node_modules/tsx/dist/cli.mjs` rather than `node_modules/.bin/tsx`.
// The `.bin` entry is a shell script (`tsx` / `tsx.cmd`) that cannot be spawned
// directly on Windows without a shell, which made every case in this file fail
// there with a null exit status. Going through the current interpreter and the
// bin target tsx itself declares is portable and needs no shell.
const TSX_CLI = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../packages/cli/src/index.ts", import.meta.url));

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [TSX_CLI, CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    // `process.env` minus DATABASE_URL by default: these cases must never
    // depend on whether the developer running them has one exported, and a test
    // that silently talks to a real database is worse than no test.
    env: { ...process.env, DATABASE_URL: "", ...env },
  });
}

// `currentUser` reads the OS account, and the interesting half of that is the
// fallback chain, which only runs when the OS lookup fails — as it does in a
// distroless container with no passwd entry for the running uid. That cannot be
// provoked from this box, where userInfo() always succeeds, so it is stubbed.
// Default state is "the real lookup succeeded", which is the production path.
const osUser = vi.hoisted(() => ({
  mode: "real" as "real" | "throw" | "empty",
  value: "ada",
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    userInfo: () => {
      if (osUser.mode === "throw") {
        throw new Error("uv_os_get_passwd failed: no entry for this uid");
      }
      return { ...actual.userInfo(), username: osUser.mode === "empty" ? "" : osUser.value };
    },
  };
});

afterEach(() => {
  osUser.mode = "real";
  osUser.value = "ada";
});

function completedCanary(corridor: Corridor) {
  const result: RunResult = {
    idempotencyKey: "canary-test",
    state: "completed",
    transactionId: "anchor-tx-1",
    stellarTxHash: "a".repeat(64),
    trail: ["created", "completed"],
  };
  const settlement: SettlementRequest = {
    to: "GDESTINATION",
    memo: "memo-1",
    memoType: "text",
    amount: { asset: corridor.settlement.bridge_asset, amount: "1.00" },
    corridor,
  };
  return { result, settlement };
}

/** Horizon facts that exactly match what `completedCanary` submitted. */
function matchingFacts(hash: string): SettlementFacts {
  return {
    hash,
    successful: true,
    memo: "memo-1",
    memoType: "text",
    operations: [
      {
        type: "payment",
        to: "GDESTINATION",
        amount: "1.0000000",
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      },
    ],
  };
}

const verifier: PaymentVerifier = {
  settlementFacts: async (hash) => ok(matchingFacts(hash)),
};

/** A throwaway copy of the comment-carrying fixture; --write mutates in place. */
function fixtureCopy(): string {
  const directory = mkdtempSync(join(tmpdir(), "corridor-canary-"));
  const manifestPath = join(directory, "verified.corridor.yaml");
  copyFileSync(join(REPO_ROOT, "tests/fixtures/verified.corridor.yaml"), manifestPath);
  return manifestPath;
}

describe("corridor CLI", () => {
  it("requires held state for run listing", () => {
    const r = run(["runs", "list", "--state", "completed"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("corridor runs list --state held");
  });

  it("requires an outcome and note to resolve a run", () => {
    const r = run(["resolve", "some-key"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--outcome");
  });

  it("requires DATABASE_URL for run listing", () => {
    const r = run(["runs", "list", "--state", "held"], { DATABASE_URL: "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("DATABASE_URL is required");
  });

  it("prints usage and exits 2 with no args", () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage: corridor <validate|plan|lint|canary|new>");
  });

  it("exits 2 on an unknown subcommand", () => {
    const r = run(["frobnicate"]);
    expect(r.status).toBe(2);
  });

  it("prints usage and exits 2 when the file arg is missing", () => {
    const r = run(["validate"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage: corridor validate");
  });

  it("validate: exits 0 for a valid manifest", () => {
    const r = run(["validate", "corridors/reference.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('id="reference-testnet"');
  });

  it("validate: exits 1 for a structurally invalid manifest", () => {
    const r = run(["validate", "tests/fixtures/invalid.corridor.yaml"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("MANIFEST_INVALID");
    expect(r.stderr).toContain("source");
  });

  it("validate: exits 1 for a nonexistent path", () => {
    const r = run(["validate", "corridors/does-not-exist.yaml"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot read or parse");
  });

  // Liveness has three states. The distinction that matters: a corridor whose
  // endpoints are merely PRESENT must never be reported as runnable — that is
  // how tooling ends up certifying a lane nobody has checked.

  it("plan: reports VERIFIED with proof: none when endpoints_verified_at is set without proof", () => {
    const r = run(["plan", "tests/fixtures/verified.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("liveness: ✓ VERIFIED");
    expect(r.stdout).toContain("2026-01-01");
    expect(r.stdout).toContain("proof:    none — amounts capped at default");
  });

  it("plan: reports PROVEN with canary hash and completion age for proven lane", () => {
    const r = run(["plan", "tests/fixtures/proven.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("liveness: ✓✓ PROVEN");
    expect(r.stdout).toContain("canary a1b2c3d4 completed 2026-09-20");
    expect(r.stdout).toContain("days ago, expires in");
  });

  it("plan: reports VERIFIED with warning when proof is stale", () => {
    const r = run(["plan", "tests/fixtures/stale-proof.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("liveness: ✓ VERIFIED");
    // A stale proof exists, so the plan must not claim there is none.
    expect(r.stdout).toContain("proof:    not current — canary a1b2c3d4 completed 2025-01-01");
    expect(r.stdout).not.toContain("proof:    none");
    expect(r.stdout).toContain("liveness warnings:");
    expect(r.stdout).toContain("proof is stale");
  });

  it("plan: reports UNVERIFIED for a fully-specified but unchecked corridor", () => {
    const r = run(["plan", "corridors/reference.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("liveness: ? UNVERIFIED");
    expect(r.stdout).toContain("NOT runnable");
    // Regression guard for the claim that got the project rejected: a corridor
    // with unconfirmed endpoints must never carry the green marker.
    expect(r.stdout).not.toContain("✓ VERIFIED");
    expect(r.stdout).not.toContain("✓✓ PROVEN");
  });

  it("plan: never reports a placeholder-endpoint corridor as runnable", () => {
    const r = run(["plan", "corridors/mx-example.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("UNVERIFIED");
    expect(r.stdout).not.toContain("✓ VERIFIED");
    expect(r.stdout).not.toContain("✓✓ PROVEN");
  });

  it("plan: reports all three liveness warnings for a corridor missing dest endpoints", () => {
    const r = run(["plan", "corridors/ng-cn.corridor.yaml"]);
    expect(r.status).toBe(0); // warnings don't fail the command
    expect(r.stdout).toContain("NOT RUNNABLE");
    expect(r.stdout).toContain("quotes will fail");
    expect(r.stdout).toContain("no per-customer KYC");
  });

  it("plan: reports VERIFIED for ng-cowrie", () => {
    const r = run(["plan", "corridors/ng-cowrie.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("liveness: ✓ VERIFIED");
    expect(r.stdout).toContain("2026-10-17");
  });

  it("plan: does not claim SEP-38 or all five steps for an external-quote corridor", () => {
    const r = run(["plan", "corridors/ng-cowrie.corridor.yaml"]);
    expect(r.status).toBe(0);
    // The lane has quote_source: external and no quote_server, so the plan must
    // not advertise a SEP-38 endpoint or certify every step. The operator's own
    // status_note says "No SEP-38", so only the generated lines are checked.
    const generated = r.stdout
      .split("\n")
      .filter((l) => !l.startsWith("note:"))
      .join("\n");
    expect(generated).not.toContain("SEP-38");
    expect(r.stdout).not.toContain("all five steps");
    // The quote line must say the quote is operator-supplied and unverified.
    expect(r.stdout).toMatch(
      /1\. quote\s+external\s+operator-supplied rate \(not verified by this tool\)/,
    );
    expect(r.stdout).toContain("liveness: ✓ VERIFIED — dest endpoints confirmed 2026-10-17");
    expect(r.stdout).toContain("not covered by endpoints_verified_at — 1. quote (external)");
  });

  it("plan: prints SEP-6 steps for a sep6 corridor and never SEP-31", () => {
    const r = run(["plan", "corridors/testanchor-sep6.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("protocol: sep6");
    expect(r.stdout).toContain("SEP-6 POST /withdraw-exchange");
    expect(r.stdout).toContain("SEP-6 GET /transaction");
    expect(r.stdout).not.toContain("SEP-31");
  });

  it("plan: keeps SEP-31 steps for a sep31 corridor", () => {
    const r = run(["plan", "tests/fixtures/verified.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("protocol: sep31");
    expect(r.stdout).toContain("SEP-31 POST /transactions");
    expect(r.stdout).toContain("SEP-31 GET /transactions/:id");
  });

  it("plan --json: emits the protocol, steps and liveness for tooling", () => {
    const r = run(["plan", "corridors/testanchor-sep6.corridor.yaml", "--json"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      protocol: string;
      steps: Array<{ verb: string; protocol: string }>;
      liveness: { state: string };
    };
    expect(parsed.protocol).toBe("sep6");
    expect(parsed.steps.map((step) => step.verb)).toEqual([
      "quote",
      "comply",
      "open",
      "settle",
      "reconcile",
    ]);
    expect(parsed.steps.map((step) => step.protocol)).not.toContain("sep31");
    expect(parsed.liveness.state).toBe("verified");
  });

  it("plan: prints the status_note when present", () => {
    const r = run(["plan", "corridors/ng-cn.corridor.yaml"]);
    expect(r.stdout).toContain("PENDING");
  });

  it("canary: requires an explicit amount", () => {
    const r = run(["canary", "tests/fixtures/verified.corridor.yaml"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--amount");
  });

  it("canary --write preserves comments and records a re-parsable PROVEN proof", async () => {
    const manifestPath = fixtureCopy();
    const loaded = loadCorridor(manifestPath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const canary = completedCanary(loaded.value);
    const finalized = await finalizeCanary({
      ...canary,
      corridor: loaded.value,
      verifier,
      manifestPath,
      write: true,
      now: new Date("2026-01-01T12:00:00.000Z"),
    });
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) return;

    const written = readFileSync(manifestPath, "utf8");
    // Every hand-written comment in the fixture survives the rewrite.
    expect(written).toContain("# Fixture: a corridor whose dest endpoints carry");
    expect(written).toContain("# anchor's data or live network reachability.");
    expect(written).toContain("proof:");
    expect(written).toContain('canary_completed_at: "2026-01-01"');
    expect(written).toContain(`stellar_tx_hash: ${"a".repeat(64)}`);

    const reparsed = loadCorridor(manifestPath);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(liveness(reparsed.value, new Date("2026-01-01T12:00:00.000Z")).state).toBe(
        "proven",
      );
    }
  });

  it("canary --write refreshes the existing proof instead of appending a second block", async () => {
    const manifestPath = fixtureCopy();
    const loaded = loadCorridor(manifestPath);
    if (!loaded.ok) throw new Error("fixture invalid");

    await finalizeCanary({
      ...completedCanary(loaded.value),
      corridor: loaded.value,
      verifier,
      manifestPath,
      write: true,
      now: new Date("2026-01-01T12:00:00.000Z"),
    });

    const afterFirst = loadCorridor(manifestPath);
    if (!afterFirst.ok) throw new Error("fixture invalid");
    const second = await finalizeCanary({
      ...completedCanary(afterFirst.value),
      result: { ...completedCanary(afterFirst.value).result, stellarTxHash: "b".repeat(64) },
      corridor: afterFirst.value,
      verifier,
      manifestPath,
      write: true,
      now: new Date("2026-01-20T12:00:00.000Z"),
    });
    expect(second.ok).toBe(true);

    const written = readFileSync(manifestPath, "utf8");
    expect(written.match(/^proof:/gm)).toHaveLength(1);
    expect(written).toContain(`stellar_tx_hash: ${"b".repeat(64)}`);
    expect(written).not.toContain("a".repeat(64));
    const reparsed = loadCorridor(manifestPath);
    if (!reparsed.ok) throw new Error("written manifest did not re-parse");
    expect(reparsed.value.proof?.canary_completed_at).toBe("2026-01-20");
  });

  it("canary refuses to write when the chain read contradicts the run", async () => {
    const manifestPath = fixtureCopy();
    const before = readFileSync(manifestPath, "utf8");
    const loaded = loadCorridor(manifestPath);
    if (!loaded.ok) throw new Error("fixture invalid");

    const mismatched: PaymentVerifier = {
      settlementFacts: async (hash) =>
        ok({ ...matchingFacts(hash), memo: "someone-elses-memo" }),
    };
    const finalized = await finalizeCanary({
      ...completedCanary(loaded.value),
      corridor: loaded.value,
      verifier: mismatched,
      manifestPath,
      write: true,
    });
    expect(finalized.ok).toBe(false);
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
  });

  it("canary refuses a payment above the recorded proof ceiling", async () => {
    const manifestPath = fixtureCopy();
    const before = readFileSync(manifestPath, "utf8");
    const loaded = loadCorridor(manifestPath);
    if (!loaded.ok) throw new Error("fixture invalid");
    const canary = completedCanary(loaded.value);

    const finalized = await finalizeCanary({
      ...canary,
      settlement: {
        ...canary.settlement,
        amount: { asset: canary.settlement.amount.asset, amount: "25.00" },
      },
      corridor: loaded.value,
      verifier,
      manifestPath,
      write: true,
    });
    expect(finalized.ok).toBe(false);
    if (!finalized.ok) expect(finalized.error.message).toContain("ceiling");
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
  });

  // Every non-completed terminal state must leave the file byte-identical, and
  // must not even reach the chain read: the guard is the first thing that runs.
  for (const state of ["failed", "held", "refunded"] as const) {
    it(`canary never writes a proof for a run that ended ${state}`, async () => {
      const manifestPath = fixtureCopy();
      const before = readFileSync(manifestPath, "utf8");
      const loaded = loadCorridor(manifestPath);
      if (!loaded.ok) throw new Error("fixture invalid");

      const canary = completedCanary(loaded.value);
      const exploding: PaymentVerifier = {
        settlementFacts: async () => {
          throw new Error("chain read must not happen for a non-completed run");
        },
      };
      const finalized = await finalizeCanary({
        ...canary,
        result: { ...canary.result, state },
        corridor: loaded.value,
        verifier: exploding,
        manifestPath,
        write: true,
      });
      expect(finalized.ok).toBe(false);
      if (!finalized.ok) expect(finalized.error.message).toContain("manifest was not changed");
      expect(readFileSync(manifestPath, "utf8")).toBe(before);
    });
  }
  describe("canary subcommand", () => {
    it("prints usage and exits 2 when the file arg is missing", () => {
      const r = run(["canary"]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("usage: corridor canary");
    });

    it("argument validation: exits 2 when --amount is missing", () => {
      const r = run(["canary", "corridors/reference.corridor.yaml"]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("--amount <amount> is required");
    });

    it("argument validation: exits 2 when --amount has no value", () => {
      const r = run(["canary", "corridors/reference.corridor.yaml", "--amount"]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("--amount requires a value");
    });

    it("argument validation: exits 2 when --amount is non-positive or malformed", () => {
      const r1 = run(["canary", "corridors/reference.corridor.yaml", "--amount", "abc"]);
      expect(r1.status).toBe(2);
      expect(r1.stderr).toContain("positive decimal amount");

      const r2 = run(["canary", "corridors/reference.corridor.yaml", "--amount", "-1.00"]);
      expect(r2.status).toBe(2);
      expect(r2.stderr).toContain("positive decimal amount");

      const r3 = run(["canary", "corridors/reference.corridor.yaml", "--amount", "0"]);
      expect(r3.status).toBe(2);
      expect(r3.stderr).toContain("positive decimal amount");
    });

    it("argument validation: exits 2 when --dry-run is combined with --write", () => {
      const r = run([
        "canary",
        "corridors/reference.corridor.yaml",
        "--amount",
        "1.00",
        "--dry-run",
        "--write",
      ]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("--write records a completed payment");
    });

    it("argument validation: exits 2 when --network is invalid", () => {
      const r = run([
        "canary",
        "corridors/reference.corridor.yaml",
        "--amount",
        "1.00",
        "--network",
        "regtest",
      ]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('--network must be "public" or "testnet"');
    });

    it("mainnet refusal without flag: exits 3 when --network public is omitted", () => {
      const r = run(["canary", "corridors/ng-cowrie.corridor.yaml", "--amount", "1.00"]);
      expect(r.status).toBe(3);
      expect(r.stderr).toContain("settles on MAINNET");
      expect(r.stderr).toContain("Pass --network public explicitly");
    });

    it("over-cap refusal: exits 3 when amount exceeds default canary cap", () => {
      const r = run(["canary", "tests/fixtures/verified.corridor.yaml", "--amount", "25.00"]);
      expect(r.status).toBe(3);
      expect(r.stderr).toContain("exceeds canary cap");
    });

    it("over-cap refusal: exits 3 when amount exceeds proof.canary_max_amount", () => {
      const r = run([
        "canary",
        "tests/fixtures/canary-capped.corridor.yaml",
        "--amount",
        "6.00",
      ]);
      expect(r.status).toBe(3);
      expect(r.stderr).toContain('exceeds canary cap "5.00"');
    });

    it("liveness refusal: exits 3 when corridor endpoints are UNVERIFIED", () => {
      const r = run(["canary", "corridors/reference.corridor.yaml", "--amount", "1.00"]);
      expect(r.status).toBe(3);
      expect(r.stderr).toContain("liveness is UNVERIFIED");
      expect(r.stderr).toContain("must be VERIFIED to run canary");
    });
  });

  it("plan: prints limits min and max when set", () => {
    const r = run(["plan", "tests/fixtures/limits.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("limits:   min=10.00 max=500.00");
  });
});

describe("corridor runs (held-run operator commands)", () => {
  const seed = async () => {
    const store = new InMemoryIdempotencyStore();
    await store.put({
      idempotencyKey: "held-1",
      corridorId: "ref",
      state: "held",
      version: 4,
      stellarTxHash: "abc123",
      lastError: "anchor stalled",
    });
    await store.put({
      idempotencyKey: "done-1",
      corridorId: "ref",
      state: "completed",
      version: 6,
    });
    return store;
  };
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
    vi.spyOn(console, "error").mockImplementation((m) => void err.push(String(m)));
    return { out, err };
  };
  afterEach(() => vi.restoreAllMocks());

  it("list prints a header and one tab-separated row per held run", async () => {
    const store = await seed();
    const { out } = capture();
    const code = await listHeldRuns(store, parseListArgs(["list", "--state", "held"])!);
    expect(code).toBe(0);
    expect(out).toEqual([
      "idempotency_key\tcorridor_id\tstate\tversion\tstellar_tx_hash\tlast_error",
      "held-1\tref\theld\t4\tabc123\tanchor stalled",
    ]);
  });

  it("resolve records the outcome for a held run and leaves the run held", async () => {
    const store = await seed();
    capture();
    const parsed = parseResolveArgs(["held-1", "--outcome", "written-off", "--note", "n"])!;
    expect(await resolveHeldRun(store, parsed, "op")).toBe(0);
    expect(await store.getResolution("held-1")).toMatchObject({
      outcome: "written-off",
      resolvedBy: "op",
    });
    expect((await store.get("held-1"))?.state).toBe("held");
  });

  it("resolve rejects a non-held run and an unknown key", async () => {
    const store = await seed();
    const { err } = capture();
    const parsed = (key: string) =>
      parseResolveArgs([key, "--outcome", "refunded-offchain", "--note", "n"])!;
    expect(await resolveHeldRun(store, parsed("done-1"), "op")).toBe(1);
    expect(await resolveHeldRun(store, parsed("missing"), "op")).toBe(1);
    expect(err.join("\n")).toContain("only an existing held run can be resolved");
    expect(await store.getResolution("done-1")).toBeUndefined();
  });

  it("resolve rejects a second resolution and keeps the first", async () => {
    const store = await seed();
    const { err } = capture();
    const first = parseResolveArgs([
      "held-1",
      "--outcome",
      "paid-out-manually",
      "--note",
      "a",
    ])!;
    const second = parseResolveArgs(["held-1", "--outcome", "written-off", "--note", "b"])!;
    expect(await resolveHeldRun(store, first, "op")).toBe(0);
    expect(await resolveHeldRun(store, second, "op2")).toBe(1);
    expect(err.join("\n")).toContain("already has an out-of-band resolution");
    expect(await store.getResolution("held-1")).toMatchObject({
      outcome: "paid-out-manually",
    });
  });
});

// --- corridor breaker -----------------------------------------------------
// A halt is only safe if reopening it is deliberate and recorded. These cases
// cover the two halves of that: the process contract (exit codes, messages) and
// the pure logic behind them (what parses, what renders).

describe("corridor breaker (process contract)", () => {
  // The headline case. A reset with no reason on record is indistinguishable,
  // months later, from somebody clearing alerts at 3am without reading the lane.
  it("reset without --reason exits 2 and says what is missing", () => {
    const r = run(["breaker", "reset", "ng-cn"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--reason");
    expect(r.stderr).toContain("requires");
  });

  it("reset with an empty --reason also exits 2", () => {
    const r = run(["breaker", "reset", "ng-cn", "--reason", "   "]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--reason");
  });

  it("reset with --reason but no DATABASE_URL exits 1, not 2", () => {
    // The arguments were fine; the environment is not. Collapsing these into one
    // code would tell an operator to fix their command when it is their env.
    const r = run(["breaker", "reset", "ng-cn", "--reason", "anchor restored"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("DATABASE_URL");
  });

  it("status without DATABASE_URL exits 1 and names the variable", () => {
    const r = run(["breaker", "status"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("DATABASE_URL");
  });

  it("exits 2 for a missing corridor id on reset", () => {
    const r = run(["breaker", "reset", "--reason", "why"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("requires a corridor id");
  });

  it("exits 2 on an unknown breaker subcommand", () => {
    const r = run(["breaker", "frobnicate"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown breaker subcommand");
  });

  it("exits 2 on an unknown flag rather than treating it as a corridor id", () => {
    const r = run(["breaker", "reset", "ng-cn", "--reason", "why", "--force"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown flag");
  });

  it("exits 2 on more than one corridor id", () => {
    const r = run(["breaker", "status", "a", "b"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("at most one corridor id");
  });

  it("prints the breaker usage for `corridor breaker` with no subcommand", () => {
    const r = run(["breaker"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("corridor breaker status");
    expect(r.stderr).toContain("--reason");
  });

  it("validate and plan keep working with no DATABASE_URL set", () => {
    // The breaker commands read a database; the manifest commands must not need
    // one, or a dev box without Postgres cannot check a manifest at all.
    expect(run(["validate", "corridors/reference.corridor.yaml"]).status).toBe(0);
    expect(run(["plan", "corridors/reference.corridor.yaml"]).status).toBe(0);
  });
});

describe("parseBreakerArgs", () => {
  it("accepts status with and without a corridor id", () => {
    expect(parseBreakerArgs(["status"])).toEqual({
      ok: true,
      command: { kind: "status", corridorId: undefined },
    });
    expect(parseBreakerArgs(["status", "ng-cn"])).toEqual({
      ok: true,
      command: { kind: "status", corridorId: "ng-cn" },
    });
  });

  it("accepts both --reason forms", () => {
    expect(parseBreakerArgs(["reset", "ng-cn", "--reason", "anchor restored"])).toEqual({
      ok: true,
      command: { kind: "reset", corridorId: "ng-cn", reason: "anchor restored" },
    });
    expect(parseBreakerArgs(["reset", "--reason=anchor restored", "ng-cn"])).toEqual({
      ok: true,
      command: { kind: "reset", corridorId: "ng-cn", reason: "anchor restored" },
    });
  });

  it("keeps a multi-word reason intact", () => {
    const r = parseBreakerArgs([
      "reset",
      "ng-cn",
      "--reason",
      "checked with the anchor on call",
    ]);
    expect(r.ok).toBe(true);
    if (r.ok && r.command.kind === "reset") {
      expect(r.command.reason).toBe("checked with the anchor on call");
    }
  });

  it("does not let a flag's value be mistaken for the corridor id", () => {
    // `--reason ng-cn` must not be read as the corridor; without this, a reset
    // aimed at the wrong lane would succeed silently.
    const r = parseBreakerArgs(["reset", "--reason", "why", "mx-example"]);
    expect(r.ok).toBe(true);
    if (r.ok && r.command.kind === "reset") expect(r.command.corridorId).toBe("mx-example");
  });

  it("refuses a reason that is only whitespace", () => {
    const r = parseBreakerArgs(["reset", "ng-cn", "--reason", "  \t "]);
    expect(r.ok).toBe(false);
  });

  it("returns the usage text for --help instead of a command", () => {
    const r = parseBreakerArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("corridor breaker reset");
  });
});

describe("breaker status output", () => {
  const open: BreakerRecord = {
    corridorId: "ng-cn",
    state: "open",
    consecutiveFailures: 3,
    trippedAt: Date.parse("2026-09-28T12:00:00.000Z"),
    lastError: "RECONCILE_STALLED: anchor never reported a terminal status",
    updatedAt: Date.parse("2026-09-28T12:00:00.000Z"),
  };

  it("shows a halted lane with its mark, when it tripped and why", () => {
    const out = formatBreakerRecord(open, "ng-cn");
    expect(out).toContain("corridor: ng-cn");
    expect(out).toContain("OPEN");
    expect(out).toContain("2026-09-28T12:00:00.000Z");
    expect(out).toContain("RECONCILE_STALLED");
    expect(out).toContain("failures: 3 consecutive");
  });

  it("distinguishes a lane with no row from a healthy one", () => {
    // "No evidence" and "evidence of health" are different claims, and an
    // operator acting on the difference is the whole point of the command.
    const out = formatBreakerRecord(undefined, "brand-new");
    expect(out).toContain("UNKNOWN");
    expect(out).not.toContain("CLOSED");
  });

  it("shows a closed lane as accepting work", () => {
    const out = formatBreakerRecord(
      { corridorId: "ng-cn", state: "closed", consecutiveFailures: 0, updatedAt: 0 },
      "ng-cn",
    );
    expect(out).toContain("CLOSED");
    expect(out).toContain("accepting new runs");
  });

  it("never claims how close a lane is to tripping", () => {
    // The threshold is in the manifest, not the row. Reporting "1 short of
    // tripping" would be a guess, and a wrong one whenever the operator has
    // changed recovery.breaker.consecutive_failures. The count alone is honest.
    const out = formatBreakerRecord(
      { corridorId: "ng-cn", state: "closed", consecutiveFailures: 2, updatedAt: 0 },
      "ng-cn",
    );
    expect(out).toContain("failures: 2 consecutive");
    expect(out).toContain("still accepting new runs");
    expect(out).not.toContain("short of tripping");
  });

  it("lists every lane, halted ones first", () => {
    const closed: BreakerRecord = {
      corridorId: "aaa-closed",
      state: "closed",
      consecutiveFailures: 0,
      updatedAt: 0,
    };
    const out = formatBreakerTable([closed, open]);
    const lines = out.split("\n");
    // Header, rule, then rows. The halted lane must not be the second data row.
    expect(lines[0]).toContain("CORRIDOR");
    expect(lines[0]).toContain("STATE");
    expect(lines[2]).toContain("ng-cn");
    expect(lines[3]).toContain("aaa-closed");
  });

  it("says so plainly when nothing has failed anywhere", () => {
    expect(formatBreakerTable([])).toContain("no breaker state recorded");
  });

  it("confirms a reset with who did it, when and why", () => {
    const out = formatBreakerReset(
      {
        corridorId: "ng-cn",
        state: "closed",
        consecutiveFailures: 0,
        resetBy: "ezedike",
        resetReason: "anchor confirmed healthy",
        resetAt: 5000,
        updatedAt: 5000,
      },
      true,
    );
    expect(out).toContain("CLOSED");
    expect(out).toContain("by:       ezedike");
    expect(out).toContain("anchor confirmed healthy");
    // The lane really was halted, so there is no caveat to print.
    expect(out).not.toContain("not halted");
  });

  it("prints the name the store recorded, and 'unknown' when it recorded none", () => {
    const base = {
      corridorId: "ng-cn",
      state: "closed" as const,
      consecutiveFailures: 0,
      resetReason: "r",
      resetAt: 5000,
      updatedAt: 5000,
    };
    expect(formatBreakerReset({ ...base, resetBy: "recorded-name" }, true)).toContain(
      "by:       recorded-name",
    );
    expect(formatBreakerReset(base, true)).toContain("by:       unknown");
  });

  it("flags a reset of a lane that was not halted", () => {
    // Resetting a healthy lane usually means re-running a command someone
    // thought had failed. Saying "reopened" there would be a lie.
    const out = formatBreakerReset(
      {
        corridorId: "ng-cn",
        state: "closed",
        consecutiveFailures: 0,
        resetBy: "ezedike",
        resetReason: "why not",
        resetAt: 5000,
        updatedAt: 5000,
      },
      false,
    );
    expect(out).toContain("was not halted");
  });
});

// The reset is only auditable if the name in `reset_by` is the person who ran
// the command, so the function that produces it is worth pinning on its own.
// The plumbing that passes it to `store.reset` is covered by the store tests;
// what those cannot see is whether this function can lose the field entirely.
describe("currentUser", () => {
  it("prefers the OS account over the environment", () => {
    osUser.mode = "real";
    osUser.value = "ada";
    // Every variable is set: if the env were consulted first, or first-wins
    // were wrong, this would return something else and the recorded `reset_by`
    // would name the wrong person.
    expect(currentUser({ USER: "from-env", USERNAME: "from-env", LOGNAME: "from-env" })).toBe(
      "ada",
    );
  });

  it("falls back through USER, USERNAME and LOGNAME when the OS lookup fails", () => {
    // The distroless-container path: no passwd entry for the uid, so the audit
    // field survives on the environment instead of being lost.
    osUser.mode = "throw";
    expect(currentUser({ USER: "ada", USERNAME: "grace", LOGNAME: "alan" })).toBe("ada");
    expect(currentUser({ USERNAME: "grace", LOGNAME: "alan" })).toBe("grace");
    expect(currentUser({ LOGNAME: "alan" })).toBe("alan");
  });

  it("treats an empty OS username as no username", () => {
    osUser.mode = "empty";
    expect(currentUser({ USERNAME: "grace" })).toBe("grace");
  });

  it("returns 'unknown' only when every source is empty", () => {
    // The last resort, and it is a real value rather than a blank string: a
    // blank `reset_by` would read as a reset nobody was accountable for.
    osUser.mode = "throw";
    expect(currentUser({})).toBe("unknown");
    expect(currentUser({ USER: "", USERNAME: "", LOGNAME: "" })).toBe("unknown");
  });

  it("always returns a non-blank name on this machine", () => {
    osUser.mode = "real";
    osUser.value = "ada";
    const u = currentUser({});
    expect(u.length).toBeGreaterThan(0);
    expect(u.trim()).toBe(u);
  });
});

describe("corridor lint", () => {
  const cowrieManifest = () => {
    const loaded = loadCorridor(join(REPO_ROOT, "corridors/ng-cowrie.corridor.yaml"));
    if (!loaded.ok) throw new Error("failed to load ng-cowrie.corridor.yaml");
    return loaded.value;
  };

  it("matches when manifest endpoints agree with stellar.toml (normalising trailing slashes)", () => {
    const toml = [
      'DIRECT_PAYMENT_SERVER = "https://api.cowrie.exchange/sep31/direct/"',
      'WEB_AUTH_ENDPOINT = "https://api.cowrie.exchange/web_auth"',
      'KYC_SERVER = "https://api.cowrie.exchange/kyc/"',
    ].join("\n");

    const res = compareManifestToToml(cowrieManifest(), toml);
    expect(res.ok).toBe(true);
    expect(res.findings).toEqual([]);
  });

  it("accepts single-quoted values in stellar.toml (as used by cowrie.exchange)", () => {
    const toml = [
      "DIRECT_PAYMENT_SERVER = 'https://api.cowrie.exchange/sep31/direct'",
      "WEB_AUTH_ENDPOINT = 'https://api.cowrie.exchange/web_auth'",
      "KYC_SERVER = 'https://api.cowrie.exchange/kyc'",
    ].join("\n");

    const res = compareManifestToToml(cowrieManifest(), toml);
    expect(res.ok).toBe(true);
    expect(res.findings).toEqual([]);
    expect(formatLintResult(res)).toContain(
      "all manifest endpoints match published stellar.toml",
    );
  });

  it("reports a mismatch when a manifest endpoint differs from the published stellar.toml", () => {
    const toml = [
      'DIRECT_PAYMENT_SERVER = "https://api.cowrie.exchange/v2/sep31"',
      'WEB_AUTH_ENDPOINT = "https://api.cowrie.exchange/web_auth"',
      'KYC_SERVER = "https://api.cowrie.exchange/kyc"',
    ].join("\n");

    const res = compareManifestToToml(cowrieManifest(), toml);
    expect(res.ok).toBe(false);
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]).toMatchObject({
      severity: "error",
      kind: "value_mismatch",
      field: "transfer_server_sep31",
      tomlKey: "DIRECT_PAYMENT_SERVER",
      manifestValue: "https://api.cowrie.exchange/sep31/direct",
      tomlValue: "https://api.cowrie.exchange/v2/sep31",
    });
  });

  it("reports an error when the manifest pins an endpoint whose key is absent in stellar.toml", () => {
    const toml = [
      'DIRECT_PAYMENT_SERVER = "https://api.cowrie.exchange/sep31/direct"',
      'WEB_AUTH_ENDPOINT = "https://api.cowrie.exchange/web_auth"',
      // KYC_SERVER missing
    ].join("\n");

    const res = compareManifestToToml(cowrieManifest(), toml);
    expect(res.ok).toBe(false);
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]).toMatchObject({
      severity: "error",
      kind: "missing_in_toml",
      field: "kyc_server",
      tomlKey: "KYC_SERVER",
      manifestValue: "https://api.cowrie.exchange/kyc",
    });
  });

  it("emits a warning (without failing) when stellar.toml publishes an endpoint omitted by the manifest", () => {
    const toml = [
      'DIRECT_PAYMENT_SERVER = "https://api.cowrie.exchange/sep31/direct"',
      'WEB_AUTH_ENDPOINT = "https://api.cowrie.exchange/web_auth"',
      'KYC_SERVER = "https://api.cowrie.exchange/kyc"',
      'ANCHOR_QUOTE_SERVER = "https://api.cowrie.exchange/sep38"',
    ].join("\n");

    const res = compareManifestToToml(cowrieManifest(), toml);
    expect(res.ok).toBe(true);
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]).toMatchObject({
      severity: "warning",
      kind: "omitted_in_manifest",
      field: "quote_server",
      tomlKey: "ANCHOR_QUOTE_SERVER",
      tomlValue: "https://api.cowrie.exchange/sep38",
    });
    expect(formatLintResult(res)).toContain("! warning:");
  });

  it("fetches stellar.toml via injected fetchImpl and reports mismatches", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(
        [
          "DIRECT_PAYMENT_SERVER = 'https://api.cowrie.exchange/sep31/direct'",
          "WEB_AUTH_ENDPOINT = 'https://api.cowrie.exchange/web_auth'",
          "KYC_SERVER = 'https://api.cowrie.exchange/kyc-new'",
        ].join("\n"),
        { status: 200 },
      );
    }) as typeof fetch;

    const res = await lintCorridor(cowrieManifest(), { fetchImpl });
    expect(calls).toEqual(["https://cowrie.exchange/.well-known/stellar.toml"]);
    expect(res.ok).toBe(false);
    expect(res.findings[0]?.kind).toBe("value_mismatch");
  });

  it("skips localhost and .invalid/.example placeholder domains without calling fetch", async () => {
    expect(isPlaceholderDomain("localhost:8080")).toBe(true);
    expect(isPlaceholderDomain("example-cn-anchor.invalid")).toBe(true);
    expect(isPlaceholderDomain("anchor.example.mx")).toBe(true);
    expect(isPlaceholderDomain("cowrie.exchange")).toBe(false);

    const explodingFetch = (async () => {
      throw new Error("fetch must not be called for placeholder domains");
    }) as unknown as typeof fetch;

    for (const path of [
      "corridors/reference.corridor.yaml",
      "corridors/mx-example.corridor.yaml",
      "corridors/ng-cn.corridor.yaml",
    ]) {
      const loaded = loadCorridor(join(REPO_ROOT, path));
      if (!loaded.ok) throw new Error(`failed to load ${path}`);
      const res = await lintCorridor(loaded.value, { fetchImpl: explodingFetch });
      expect(res.skipped).toBe(true);
      expect(res.ok).toBe(true);
      expect(formatLintResult(res)).toContain("skipped: placeholder domain");
    }
  });

  it("CLI subcommand: prints skipped: placeholder domain and exits 0 for reference/template corridors", () => {
    const r1 = run(["lint", "corridors/reference.corridor.yaml"]);
    expect(r1.status).toBe(0);
    expect(r1.stdout).toContain("skipped: placeholder domain");

    const r2 = run(["lint", "corridors/mx-example.corridor.yaml"]);
    expect(r2.status).toBe(0);
    expect(r2.stdout).toContain("skipped: placeholder domain");

    const r3 = run(["lint", "corridors/ng-cn.corridor.yaml"]);
    expect(r3.status).toBe(0);
    expect(r3.stdout).toContain("skipped: placeholder domain");
  });

  it("CLI subcommand: exits 2 when the file argument is missing", () => {
    const r = run(["lint"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage: corridor lint <file.corridor.yaml>");
  });
});

describe("corridor routes (#619)", () => {
  describe("argument validation (spawned CLI, no network)", () => {
    it("exits 2 when --amount is missing", () => {
      const r = run(["routes", "--to", "NGN", "--country", "NG"]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("--amount <amount> is required");
    });

    it("exits 2 on an amount that is not a positive decimal", () => {
      for (const amount of ["abc", "0", "-5", "1e3"]) {
        const r = run(["routes", "--amount", amount, "--to", "NGN", "--country", "NG"]);
        expect(r.status).toBe(2);
        expect(r.stderr).toContain("positive decimal amount");
      }
    });

    it("exits 2 on an unknown option, a stray argument or a bad --network", () => {
      const base = ["routes", "--amount", "100", "--to", "NGN", "--country", "NG"];
      expect(run([...base, "--unknown-flag"]).stderr).toContain(
        'unknown option "--unknown-flag"',
      );
      expect(run([...base, "extra"]).status).toBe(2);
      const bad = run([...base, "--network", "mainnet"]);
      expect(bad.status).toBe(2);
      expect(bad.stderr).toContain('--network must be "testnet" or "public"');
    });

    it("exits 2 when --offline is asked for a label only an anchor can give", () => {
      const r = run([
        "routes",
        "--amount",
        "100",
        "--to",
        "NGN",
        "--country",
        "NG",
        "--offline",
        "--labels",
        "locked",
      ]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("--offline contacts no anchor");
    });

    it("exits 1 without planning when --network has no registry", () => {
      // contracts/deployments.json has no public registry yet; the planner never
      // offers an anchor without evidence, so there is nothing to plan with.
      const r = run(
        ["routes", "--amount", "100", "--to", "NGN", "--country", "NG", "--network", "public"],
        { REGISTRY_CONTRACT_ID: "" },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("no registry deployed on public");
    });
  });

  describe("parseRoutesArgs", () => {
    it("builds the RFC 0004 RouteRequest, with testnet and ./corridors by default", () => {
      const r = parseRoutesArgs(["--amount", "100", "--to", "NGN", "--country", "ng"]);
      expect(r).toEqual({
        ok: true,
        value: {
          request: {
            sourceAmount: { asset: "USDC", amount: "100" },
            destAsset: "iso4217:NGN",
            destCountry: "NG",
          },
          network: "testnet",
          dir: "corridors",
          offline: false,
          json: false,
        },
      });
    });

    it("maps the payout method and policy flags onto the request", () => {
      const r = parseRoutesArgs([
        "--amount=50.5",
        "--from",
        "USDC",
        "--to",
        "iso4217:KES",
        "--country",
        "KE",
        "--payout-method",
        "mobile_money",
        "--labels",
        "locked,indicative",
        "--margin-bps",
        "75",
        "--window-days",
        "14",
        "--guarantee-estimates",
        "--network",
        "public",
        "--dir",
        "x",
        "--json",
      ]);
      expect(r.ok && r.value.request).toEqual({
        sourceAmount: { asset: "USDC", amount: "50.5" },
        destAsset: "iso4217:KES",
        destCountry: "KE",
        payoutMethod: "mobile_money",
        policy: {
          allowedLabels: ["locked", "indicative"],
          estimateMarginBps: 75,
          estimateWindowDays: 14,
          guaranteeEstimates: true,
        },
      });
      expect(r.ok && [r.value.network, r.value.dir, r.value.json]).toEqual([
        "public",
        "x",
        true,
      ]);
    });

    it("refuses labels, margins and windows POST /routes would refuse", () => {
      const base = ["--amount", "1", "--to", "NGN", "--country", "NG"];
      for (const extra of [
        ["--labels", "firm"],
        ["--labels", "locked,locked"],
        ["--margin-bps", "10000"],
        ["--margin-bps", "1.5"],
        ["--window-days", "0"],
        ["--window-days", "91"],
        ["--country", "NGA"],
      ]) {
        expect(parseRoutesArgs([...base, ...extra]).ok).toBe(false);
      }
    });

    it("reads a bare currency code as its SEP-38 iso4217 asset and keeps anything else", () => {
      expect(toDestAsset("ngn")).toBe("iso4217:NGN");
      expect(toDestAsset("iso4217:NGN")).toBe("iso4217:NGN");
      expect(toDestAsset("stellar:USDC:GABC")).toBe("stellar:USDC:GABC");
    });
  });

  describe("planning (planRoutes with injected registry, fetch and rate history)", () => {
    const NOW = Date.parse("2026-11-20T00:00:00Z");

    /** A proven NGN lane to `domain`, on testnet. */
    function lane(
      id: string,
      domain: string,
      endpoints: Record<string, string> = {},
    ): Corridor {
      const r = parseCorridor({
        id,
        source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
        dest: {
          name: id,
          asset: "iso4217:NGN",
          endpoints: {
            home_domain: domain,
            transfer_server_sep31: `https://${domain}/sep31`,
            endpoints_verified_at: "1970-01-01",
            ...endpoints,
          },
        },
        fx: { path: ["USDC", "NGN"], who_holds_risk: "receiving_anchor" },
        compliance: { source_jurisdiction: "US", dest_jurisdiction: "NG" },
        settlement: { network: "testnet", asset_issuer: "GISSUER" },
        recovery: {},
        proof: {
          canary_completed_at: "1970-01-01T00:00:00Z",
          stellar_tx_hash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
          anchor_transaction_id: "canary-test",
          amount: "1",
          max_age_days: 50000,
        },
      });
      if (!r.ok) throw new Error(`fixture ${id} invalid: ${r.error.message}`);
      return r.value;
    }

    /** Registry fake: only `attested` domains serve; every attestation is fresh. */
    function registry(attested: readonly string[]): AttestationSource {
      return {
        serves: async (domain) => attested.includes(domain),
        staleness: async () => 0,
        tomlHash: async () => "hash",
      };
    }

    /** SEP-38 GET /price fake: 100 USDC buys the amount set for the quote server's host. */
    function priceFeed(byHost: Record<string, string>, asked: string[]) {
      return vi.fn(async (url: string | URL | Request) => {
        const u = new URL(String(url));
        asked.push(u.toString());
        const buy = byHost[u.host];
        if (!buy) return new Response("{}", { status: 404 });
        return new Response(JSON.stringify({ sell_amount: "100", buy_amount: buy }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
    }

    /** 120 samples at `rate`, one every 96 minutes back from NOW: 8 days of history. */
    function history(rate: string) {
      return Array.from({ length: 120 }, (_, i) => ({
        rate,
        sampledAt: NOW - i * 96 * 60_000,
        outlier: false,
      }));
    }

    const corridors = [
      lane("lane-a", "a.example", { quote_server: "https://a.example/sep38" }),
      lane("lane-b", "b.example", { quote_server: "https://b.example/sep38" }),
      lane("lane-c", "c.example"),
      lane("lane-u", "u.example", { quote_server: "https://u.example/sep38" }),
    ];

    function args(argv: string[] = []): RoutesArgs {
      const r = parseRoutesArgs([
        "--amount",
        "100",
        "--to",
        "NGN",
        "--country",
        "NG",
        ...argv,
      ]);
      if (!r.ok) throw new Error(r.error);
      return r.value;
    }

    it("live: offers indicative prices from SEP-38 GET /price, best recipient amount first, and says why the rest were dropped", async () => {
      const asked: string[] = [];
      const plan = await planCliRoutes(args(), corridors, {
        registry: registry(["a.example", "b.example", "c.example"]),
        fetch: priceFeed({ "a.example": "150000", "b.example": "152000" }, asked),
        now: () => NOW,
      });

      expect(plan.offered.map((o) => [o.receivingDomain, o.price.label])).toEqual([
        ["b.example", "indicative"],
        ["a.example", "indicative"],
      ]);
      const best = plan.offered[0]!;
      expect(best.recipientGets).toEqual({ asset: "iso4217:NGN", amount: "152000" });
      expect(best.price.rate).toBe("1520");
      expect(best.reliability).toBeGreaterThan(0);
      expect(best.reasons[0]).toBe("ranked 1 of 2");

      const dropped = Object.fromEntries(plan.dropped.map((d) => [d.corridorId, d.reason]));
      // No quote server and no rate history: every label is dropped with its reason.
      expect(dropped["lane-c"]).toContain("locked: no quote adapter configured");
      expect(dropped["lane-c"]).toContain(
        "indicative: no SEP-38 quote server in the manifest",
      );
      expect(dropped["lane-c"]).toContain("estimated: no rate history configured");
      // Not attested: never priced.
      expect(dropped["lane-u"]).toBeDefined();
      expect(asked.some((u) => u.includes("u.example"))).toBe(false);
      expect(asked.every((u) => u.includes("/sep38/price?"))).toBe(true);
    });

    it("live: an estimated price comes from rate history, never from nothing", async () => {
      const plan = await planCliRoutes(args(["--labels", "estimated"]), corridors, {
        registry: registry(["c.example"]),
        rateHistory: rateHistoryFrom({ list: async () => history("1500") }),
        now: () => NOW,
      });
      expect(plan.offered).toHaveLength(1);
      expect(plan.offered[0]).toMatchObject({
        receivingDomain: "c.example",
        price: { label: "estimated" },
        recipientGets: { asset: "iso4217:NGN" },
      });
      expect(plan.offered[0]!.reasons).toContain("estimate not guaranteed");
    });

    it("--offline contacts no anchor: only estimated prices, from local rate history", async () => {
      const fetchSpy = vi.fn() as unknown as typeof fetch;
      const plan = await planCliRoutes(args(["--offline"]), corridors, {
        registry: registry(["a.example", "c.example"]),
        fetch: fetchSpy,
        rateHistory: rateHistoryFrom({
          list: async (f) => (f.anchorDomain === "c.example" ? history("1500") : []),
        }),
        now: () => NOW,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(plan.offered.map((o) => [o.receivingDomain, o.price.label])).toEqual([
        ["c.example", "estimated"],
      ]);
      const a = plan.dropped.find((d) => d.corridorId === "lane-a");
      expect(a?.reason).toContain("estimated:");
      expect(a?.reason).not.toContain("indicative");
    });

    it("rate history reads only the receiving anchor's own samples for the pair", async () => {
      const filters: unknown[] = [];
      const source = rateHistoryFrom({
        list: async (f) => {
          filters.push(f);
          return [{ rate: "1500.1", sampledAt: 5, outlier: true }];
        },
      });
      const samples = await source({
        receivingDomain: "c.example",
        sellAsset: "stellar:USDC:GISSUER",
        buyAsset: "iso4217:NGN",
        sinceMs: 1,
      });
      expect(filters).toEqual([
        {
          anchorDomain: "c.example",
          sellAsset: "stellar:USDC:GISSUER",
          buyAsset: "iso4217:NGN",
          since: 1,
        },
      ]);
      expect(samples).toEqual([{ rate: "1500.1", timestampMs: 5, outlier: true }]);
    });

    it("prints offered options in rank order with label, rate, recipient amount, reliability and reasons, then the dropped ones", async () => {
      const a = args();
      const plan = await planCliRoutes(a, corridors, {
        registry: registry(["a.example", "b.example", "c.example"]),
        fetch: priceFeed({ "a.example": "150000", "b.example": "152000" }, []),
        now: () => NOW,
      });
      const out = formatRoutes(a.request, plan, {
        network: "testnet",
        registry: "CREG",
        offline: false,
        rateHistory: false,
      });
      expect(out).toContain("routes for 100 USDC -> iso4217:NGN in NG");
      expect(out).toContain("CREG on testnet");
      expect(out.indexOf("1. b.example")).toBeLessThan(out.indexOf("2. a.example"));
      expect(out).toContain("1. b.example (lane-b, sep31) — indicative");
      expect(out).toContain("rate:           1520");
      expect(out).toContain("recipient gets: 152000 iso4217:NGN");
      expect(out).toMatch(/reliability: {4}\d\.\d\d/);
      expect(out).toContain("- ranked 1 of 2");
      expect(out).toContain("dropped (2):");
      expect(out).toContain("c.example (lane-c, sep31): unpriceable");
    });
  });

  describe("registryFor", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("refuses a network with no registry in contracts/deployments.json", () => {
      vi.stubEnv("REGISTRY_CONTRACT_ID", "");
      const r = registryFor("public", { public: { registry: null } });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain("no registry deployed on public");
    });

    it("uses the network's registry, or REGISTRY_CONTRACT_ID when set", () => {
      vi.stubEnv("REGISTRY_CONTRACT_ID", "");
      // Real ids from contracts/deployments.json; building the client reads nothing.
      const registryId = "CDFOVONWR3GGMGH2OC7YATRZE64RKSRAS7UMF7R2TSC6LNNO5G32RSX4";
      const otherId = "CAHSKTAVHIES6MX2DUGNBA4VDB77WYNKEIZPOT7QX2RMJUL5RUIVKX2L";
      const deployments = { testnet: { registry: registryId, rpcUrl: "https://rpc.invalid" } };
      const r = registryFor("testnet", deployments);
      expect(r.ok && r.contractId).toBe(registryId);
      vi.stubEnv("REGISTRY_CONTRACT_ID", otherId);
      const o = registryFor("testnet", deployments);
      expect(o.ok && o.contractId).toBe(otherId);
    });

    it("reports a malformed REGISTRY_CONTRACT_ID instead of throwing", () => {
      vi.stubEnv("REGISTRY_CONTRACT_ID", "CNOTACONTRACT");
      const r = registryFor("testnet", { testnet: { registry: null } });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain("registry CNOTACONTRACT on testnet");
    });
  });
});
