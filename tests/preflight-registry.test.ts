import { describe, expect, it } from "vitest";
import { preflightRegistry, PROBE_NAMES } from "@corridor/registry";
import { rpc } from "@stellar/stellar-sdk";

describe("preflightRegistry (#584)", () => {
  it("fails when no registry is configured for network in deployments", async () => {
    const res = await preflightRegistry({
      network: "non-existent-network",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("no registry contract deployed on network");
  });

  it("detects when deployed contract is behind PROBE_NAMES and returns actionable error", async () => {
    // Mock RPC server simulating an older registry that rejects probe bits >= 5 with UnknownBit (#4)
    const mockServer = {
      async simulateTransaction(tx: unknown) {
        // Check if testing an unsupported bit
        const txStr = JSON.stringify(tx);
        if (txStr.includes("preflight-check.example")) {
          return {
            error: "HostError: Error(Contract, #4)",
          } as unknown as rpc.Api.SimulateTransactionResponse;
        }
        return {} as unknown as rpc.Api.SimulateTransactionResponse;
      },
    };

    const res = await preflightRegistry({
      network: "testnet",
      contractId: "CDFOVONWR3GGMGH2OC7YATRZE64RKSRAS7UMF7R2TSC6LNNO5G32RSX4",
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      server: mockServer as unknown as rpc.Server,
      probesToCheck: ["future_probe_1", "future_probe_2"],
    });

    expect(res.ok).toBe(false);
    expect(res.missingProbes).toContain("future_probe_1");
    expect(res.error).toBe(
      "deployed registry contract on testnet is behind main: upgrade() the registry to current PROBE_NAMES before running attestation (run pnpm upgrade:registry)",
    );
  });

  it("detects missing contract functions and flags them in missingFunctions", async () => {
    const mockServer = {
      async simulateTransaction() {
        return {
          error: "HostError: Error(WasmVm, MissingValue)",
        } as unknown as rpc.Api.SimulateTransactionResponse;
      },
    };

    const res = await preflightRegistry({
      network: "testnet",
      contractId: "CDFOVONWR3GGMGH2OC7YATRZE64RKSRAS7UMF7R2TSC6LNNO5G32RSX4",
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      server: mockServer as unknown as rpc.Server,
      probesToCheck: ["toml_fetch"],
    });

    expect(res.ok).toBe(false);
    expect(res.missingFunctions.length).toBeGreaterThan(0);
    expect(res.error).toContain("is behind main");
  });

  it("passes against live testnet registry contract for all 7 current PROBE_NAMES", async () => {
    const res = await preflightRegistry({ network: "testnet" });
    expect(res.ok).toBe(true);
    expect(res.supportedProbes).toEqual([...PROBE_NAMES]);
    expect(res.missingProbes).toEqual([]);
    expect(res.missingFunctions).toEqual([]);
  });
});
