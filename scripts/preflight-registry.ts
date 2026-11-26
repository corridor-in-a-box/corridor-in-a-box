// Registry preflight (#584): checks that the deployed registry and attester on
// STELLAR_NETWORK (default testnet) accept every SEP and probe bit and export every
// function this checkout uses. Read-only; needs no key.
//
// Prints one line. Exits 1 whenever the contracts are behind main, so the nightly
// attestation cannot fall behind silently. Under GitHub Actions it also sets the
// step output `blocking`: `true` when attesting now would fail per anchor (the
// workflow then skips the submit step), `false` when only functions that
// `pnpm attest` already skips are missing (the writes that can land still do).

import { appendFileSync } from "node:fs";
import { preflightRegistry } from "@corridor/registry";

function setOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value}\n`);
}

async function main(): Promise<void> {
  const network = process.env.STELLAR_NETWORK ?? "testnet";
  const r = await preflightRegistry({ network });
  setOutput("blocking", String(r.blocking));
  if (!r.ok) {
    const annotation = process.env.GITHUB_ACTIONS === "true" ? "::error::" : "✗ ";
    console.error(`${annotation}${r.error}`);
    process.exit(1);
  }
  console.log(
    `✓ registry ${r.registryId} on ${r.network} is current ` +
      `(wasm ${r.registryWasmHash ?? "?"}${r.attesterId ? `, attester wasm ${r.attesterWasmHash ?? "?"}` : ""})`,
  );
}

main().catch((err: unknown) => {
  setOutput("blocking", "true");
  console.error(
    `✗ registry preflight failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
