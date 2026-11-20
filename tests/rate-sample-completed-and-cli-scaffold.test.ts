import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createMockAdapter } from "@corridor/adapter-kit";
import {
  execute,
  InMemoryIdempotencyStore,
  createMockSubmitter,
  type EngineDeps,
  type CompletedRateSample,
} from "@corridor/engine";
import {
  loadCorridor,
  manifestFromAttestation,
  parseCorridorYaml,
  parseYaml,
  type AttestedAnchorData,
} from "@corridor/manifest";
import type { AnchorAttestation } from "@corridor/registry";
import { StaticRouteResolver } from "@corridor/router";
import type { PaymentIntent } from "@corridor/types";
import { newCommand, parseNewArgs } from "../packages/cli/src/new";

describe("Rate history: record effective rate of completed payments (#594)", () => {
  const corridorPath = resolve(__dirname, "../corridors/reference.corridor.yaml");
  const loaded = loadCorridor(corridorPath);
  if (!loaded.ok) throw new Error("failed to load corridor");
  const corridor = loaded.value;

  const intent: PaymentIntent = {
    idempotencyKey: "test-completed-rate-sample-key-1",
    corridorId: corridor.id,
    sender: { id: "test-sender" },
    recipient: { id: "test-recipient" },
    sourceAmount: { asset: "USDC", amount: "5" },
  };

  it("writes exactly one rate sample with source=own_payment when a run reaches completed", async () => {
    const recordedSamples: CompletedRateSample[] = [];

    const mockAdapter = createMockAdapter({
      settled: true,
      finalAmountIn: { asset: "USDC", amount: "5.0000000" },
      finalAmountOut: { asset: "iso4217:NGN", amount: "8250.0000000" },
    });

    const store = new InMemoryIdempotencyStore();
    const deps: EngineDeps = {
      resolver: new StaticRouteResolver(() => mockAdapter, {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter(),
      idempotency: store,
      unsafeSkipPreSettleGate: true,
      unprovenMaxAmount: "1000",
      now: () => 1700000000000,
      sleep: async () => {},
      rateHistory: (sample) => {
        recordedSamples.push(sample);
      },
    };

    const res = await execute(intent, corridor, deps, {
      trustManifestWithoutAttestation: true,
    });
    if (!res.ok) {
      console.log("Execute failed:", res.error);
    }
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.state).toBe("completed");

    // Exactly one sample recorded
    expect(recordedSamples.length).toBe(1);
    const sample = recordedSamples[0]!;
    expect(sample.source).toBe("own_payment");
    expect(sample.runId).toBe("test-completed-rate-sample-key-1");
    expect(sample.pair).toBe("USDC:iso4217:NGN");
    // 8250 / 5 = 1650
    expect(parseFloat(sample.rate)).toBeCloseTo(1650.0, 4);
    expect(sample.amountIn.amount).toBe("5.0000000");
    expect(sample.amountOut.amount).toBe("8250.0000000");

    // Idempotency: re-executing an already-completed run records NO additional samples
    const res2 = await execute(intent, corridor, deps);
    expect(res2.ok).toBe(true);
    expect(recordedSamples.length).toBe(1);
  });

  it("records exactly one sample after crash and resume", async () => {
    const recordedSamples: CompletedRateSample[] = [];
    const store = new InMemoryIdempotencyStore();

    const mockAdapter = createMockAdapter({
      settled: true,
      finalAmountIn: { asset: "USDC", amount: "5.0000000" },
      finalAmountOut: { asset: "iso4217:NGN", amount: "8000.0000000" },
    });

    const resumeKey = "test-crash-resume-key-2";
    const resumeIntent: PaymentIntent = {
      idempotencyKey: resumeKey,
      corridorId: corridor.id,
      sender: { id: "test-sender" },
      recipient: { id: "test-recipient" },
      sourceAmount: { asset: "USDC", amount: "5" },
    };

    // Simulate crash state: run was already reconciled before crash
    await store.create({
      idempotencyKey: resumeKey,
      corridorId: corridor.id,
      state: "reconciled",
      version: 5,
      transactionId: "tx_mock_crash_1",
      settlementKind: "stellar",
      stellarTxHash: "mock_tx_hash_1",
      settlement: {
        to: "GDEST",
        amount: { asset: "USDC", amount: "5" },
      },
    });

    const deps: EngineDeps = {
      resolver: new StaticRouteResolver(() => mockAdapter, {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter(),
      idempotency: store,
      unsafeSkipPreSettleGate: true,
      unprovenMaxAmount: "1000",
      now: () => 1700000000000,
      sleep: async () => {},
      rateHistory: {
        recordSample(sample) {
          recordedSamples.push(sample);
        },
      },
    };

    const res = await execute(resumeIntent, corridor, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.state).toBe("completed");

    // Exactly one sample recorded during resume to completed
    expect(recordedSamples.length).toBe(1);
    expect(recordedSamples[0]?.source).toBe("own_payment");
    expect(recordedSamples[0]?.runId).toBe(resumeKey);
    // 8000 / 5 = 1600
    expect(parseFloat(recordedSamples[0]!.rate)).toBeCloseTo(1600.0, 4);

    // Further re-executing does not add more samples
    await execute(resumeIntent, corridor, deps);
    expect(recordedSamples.length).toBe(1);
  });
});

describe("CLI scaffold corridor from attested SEP-31 anchor (#670)", () => {
  const fixtureAttestation: AttestedAnchorData = {
    domain: "fixture-anchor.example",
    seps: [1, 10, 31, 38],
    probesRun: ["toml_fetch", "sep10_auth", "sep38_quote", "sep31_info"],
    probesPassed: ["toml_fetch", "sep10_auth", "sep38_quote", "sep31_info"],
    attestedLedger: 5432100,
    tomlHash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    receiveAssets: ["iso4217:KES", "USDC"],
    country: "KE",
  };

  it("scaffolds a draft manifest from attested data with TODO placeholders", () => {
    const yaml = manifestFromAttestation(fixtureAttestation, {
      today: "2026-11-19",
      network: "testnet",
    });

    expect(yaml).toContain("id: fixture-anchor-example");
    expect(yaml).toContain("home_domain: fixture-anchor.example");
    expect(yaml).toContain("asset: iso4217:KES");
    expect(yaml).toContain("dest_jurisdiction: KE");
    expect(yaml).toContain("quote_source: sep38");

    // Verifies that unverified endpoints and credentials are marked as TODOs
    expect(yaml).toContain("[TODO: enter transfer_server_sep31 endpoint URL]");
    expect(yaml).toContain("[TODO: enter web_auth endpoint URL]");
    expect(yaml).toContain("TODO: sending-anchor.example");

    // Verifies that the draft manifest deliberately fails strict validation until TODOs are resolved
    const validation = parseCorridorYaml(yaml);
    expect(validation.ok).toBe(false);
  });

  it("refuses anchors that do not attest serving SEP-31 unless allowNotRunnable is set", () => {
    const unservedAttestation: AttestedAnchorData = {
      domain: "no-sep31.example",
      seps: [1, 10, 24],
      probesRun: ["toml_fetch", "sep10_auth"],
      probesPassed: ["toml_fetch", "sep10_auth"],
      attestedLedger: 1000,
    };

    expect(() => manifestFromAttestation(unservedAttestation)).toThrow(
      /does not attest serving SEP-31/,
    );

    const allowedYaml = manifestFromAttestation(unservedAttestation, {
      allowNotRunnable: true,
      today: "2026-11-19",
    });
    expect(allowedYaml).toContain("home_domain: no-sep31.example");
  });

  it("parses CLI args with --from-registry and executes newCommand", async () => {
    const parsed = parseNewArgs([
      "--from-registry",
      "fixture-anchor.example",
      "--network",
      "testnet",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.fromRegistry).toBe(true);
    expect(parsed.value.domain).toBe("fixture-anchor.example");
    expect(parsed.value.network).toBe("testnet");

    const mockRegistry = {
      async getAnchor(domain: string): Promise<AnchorAttestation> {
        if (domain === "fixture-anchor.example") {
          return fixtureAttestation as unknown as AnchorAttestation;
        }
        throw new Error("not found");
      },
    };

    const status = await newCommand(
      ["--from-registry", "fixture-anchor.example", "--network", "testnet"],
      { registry: mockRegistry },
    );
    expect(status).toBe(0);
  });
});

describe("Documentation and issue template for adding anchors (#671)", () => {
  it("provides an 'Add my anchor' issue template in .github/ISSUE_TEMPLATE/", () => {
    const templatePath = resolve(__dirname, "../.github/ISSUE_TEMPLATE/add_anchor.yml");
    expect(existsSync(templatePath)).toBe(true);

    const content = readFileSync(templatePath, "utf8");
    const parsed = parseYaml(content) as Record<string, unknown>;

    expect(parsed.name).toBe("Add my anchor");
    expect(parsed.description).toContain("fleet");

    const body = parsed.body as Array<Record<string, unknown>>;
    const domainInput = body.find((item) => item.id === "domain");
    expect(domainInput).toBeDefined();

    const sourceInput = body.find((item) => item.id === "source");
    expect(sourceInput).toBeDefined();
  });

  it("includes instructions in README.md on how an anchor can ask to be listed", () => {
    const readmePath = resolve(__dirname, "../README.md");
    const readme = readFileSync(readmePath, "utf8");

    expect(readme).toContain("### Asking to be added to the anchor fleet");
    expect(readme).toContain("Add my anchor");
    expect(readme).toContain("contracts/anchors.json");
  });
});
