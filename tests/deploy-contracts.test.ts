import { describe, expect, it } from "vitest";
import { runDeployment } from "../scripts/deploy-contracts.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

describe("deploy-contracts script", () => {
  it("executes dry-run simulation and generates planned sequence", async () => {
    const admin = "GBZXN7PIRZGNMHGA728R4P445QJ6T2H6K5Z326G7QZPV4T6VODV4QYTEST";
    const res = await runDeployment({
      network: "testnet",
      adminAddress: admin,
      dryRun: true,
      minInterval: 720,
    });

    expect(res.network).toBe("testnet");
    expect(res.dryRun).toBe(true);
    expect(res.registryContractId).toMatch(/^C[0-9A-Z]{55}$/);
    expect(res.attesterContractId).toMatch(/^C[0-9A-Z]{55}$/);

    expect(res.steps.length).toBe(5);
    expect(res.steps[0]?.name).toBe("Install Registry WASM");
    expect(res.steps[1]?.name).toBe("Install Attester WASM");
    expect(res.steps[2]?.name).toBe("Deploy Registry Contract");
    expect(res.steps[3]?.name).toBe("Deploy Attester Contract");
    expect(res.steps[4]?.name).toBe("Bind Registry to Attester (set_attester)");

    // Multisig signoff required on set_attester
    expect(res.steps[4]?.requiresMultisigSignoff).toBe(true);
    expect(res.steps[4]?.unsignedXdr).toBeDefined();
  });

  it("handles day-one attester enrollment step when provided", async () => {
    const admin = "GBZXN7PIRZGNMHGA728R4P445QJ6T2H6K5Z326G7QZPV4T6VODV4QYTEST";
    const attesterKey = "GA_ATTESTER_KEY_1234567890_TEST";
    const res = await runDeployment({
      network: "public",
      adminAddress: admin,
      dayOneAttester: attesterKey,
      dryRun: true,
    });

    expect(res.network).toBe("public");
    expect(res.networkPassphrase).toContain("Public Global Stellar Network");
    expect(res.steps.length).toBe(6);
    expect(res.steps[5]?.name).toBe("Enroll Day-One Attester Key (add_attester)");
    expect(res.steps[5]?.requiresMultisigSignoff).toBe(true);
    expect(res.steps[5]?.parameters.who).toBe(attesterKey);
  });

  it("verifies testnet deployment rehearsal artifact exists and is valid", () => {
    const artifactPath = join(process.cwd(), "contracts/testnet-deployment-rehearsal.json");
    expect(existsSync(artifactPath)).toBe(true);

    const content = JSON.parse(readFileSync(artifactPath, "utf8"));
    expect(content.network).toBe("testnet");
    expect(content.registryContractId).toBeDefined();
    expect(content.attesterContractId).toBeDefined();
    expect(content.steps.length).toBeGreaterThanOrEqual(5);
  });
});
