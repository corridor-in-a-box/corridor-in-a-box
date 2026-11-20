#!/usr/bin/env node
// Preflight check: verifies that the deployed registry contract supports all current
// PROBE_NAMES and functions before running anchor attestation (#584).

import { preflightRegistry } from "@corridor/registry";

async function main(): Promise<void> {
  const network = process.env.STELLAR_NETWORK ?? "testnet";
  const result = await preflightRegistry({ network });

  if (!result.ok) {
    console.error(`✗ ${result.error}`);
    process.exit(1);
  }

  console.log(
    `✓ registry contract on ${result.network} (${result.contractId}) is up to date (${result.supportedProbes.length} probe bits supported: ${result.supportedProbes.join(", ")})`,
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`✗ preflight check failed with error: ${msg}`);
  process.exit(1);
});
