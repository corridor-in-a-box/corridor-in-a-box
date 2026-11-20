import { writeFileSync } from "node:fs";
import { Networks } from "@stellar/stellar-sdk";
import { manifestFromProbe, manifestFromAttestation } from "@corridor/manifest";
import { probeAnchor, sepBit, tomlValue } from "@corridor/probe";
import { AnchorRegistry, type AnchorAttestation } from "@corridor/registry";
import deploymentsData from "../../../contracts/deployments.json";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export interface RegistrySourceLike {
  getAnchor(domain: string): Promise<AnchorAttestation>;
}

export interface NewCommandOptions {
  domain: string;
  sourceAsset?: string;
  network?: "public" | "testnet";
  outFile?: string;
  allowNotRunnable?: boolean;
  fromRegistry?: boolean;
}

export function parseNewArgs(
  args: string[],
): { ok: true; value: NewCommandOptions } | { ok: false; error: string } {
  let domain: string | undefined;
  let sourceAsset: string | undefined;
  let network: "public" | "testnet" | undefined;
  let outFile: string | undefined;
  let allowNotRunnable = false;
  let fromRegistry = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--from-registry") {
      fromRegistry = true;
      if (i + 1 < args.length && !args[i + 1].startsWith("--") && !domain) {
        domain = args[++i];
      }
    } else if (arg.startsWith("--from-registry=")) {
      fromRegistry = true;
      domain = arg.slice("--from-registry=".length);
    } else if (arg === "--source-asset") {
      if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
        return { ok: false, error: "error: --source-asset requires a value" };
      }
      sourceAsset = args[++i];
    } else if (arg.startsWith("--source-asset=")) {
      sourceAsset = arg.slice("--source-asset=".length);
    } else if (arg === "--network") {
      if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
        return { ok: false, error: "error: --network requires a value" };
      }
      const net = args[++i];
      if (net !== "public" && net !== "testnet") {
        return {
          ok: false,
          error: `error: --network must be "public" or "testnet" (got "${net}")`,
        };
      }
      network = net;
    } else if (arg.startsWith("--network=")) {
      const net = arg.slice("--network=".length);
      if (net !== "public" && net !== "testnet") {
        return {
          ok: false,
          error: `error: --network must be "public" or "testnet" (got "${net}")`,
        };
      }
      network = net;
    } else if (arg === "--out") {
      if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
        return { ok: false, error: "error: --out requires a value" };
      }
      outFile = args[++i];
    } else if (arg.startsWith("--out=")) {
      outFile = arg.slice("--out=".length);
    } else if (arg === "--allow-not-runnable") {
      allowNotRunnable = true;
    } else if (arg.startsWith("--")) {
      return { ok: false, error: `error: unknown option "${arg}"` };
    } else {
      if (!domain) {
        domain = arg;
      } else {
        return { ok: false, error: `error: unexpected argument "${arg}"` };
      }
    }
  }

  if (!domain) {
    return {
      ok: false,
      error:
        "usage: corridor new <domain> [--from-registry] [--source-asset <asset>] [--network <public|testnet>] [--out <file>] [--allow-not-runnable]\n" +
        "       corridor new --from-registry <domain> [options]",
    };
  }

  return {
    ok: true,
    value: {
      domain,
      sourceAsset,
      network,
      outFile,
      allowNotRunnable,
      ...(fromRegistry ? { fromRegistry: true } : {}),
    },
  };
}

export async function newCommand(
  args: string[],
  deps?: { registry?: RegistrySourceLike },
): Promise<number> {
  const parsed = parseNewArgs(args);
  if (!parsed.ok) {
    console.error(parsed.error);
    return EXIT_USAGE;
  }
  const { domain, sourceAsset, network, outFile, allowNotRunnable, fromRegistry } =
    parsed.value;

  if (fromRegistry) {
    const net = network ?? "testnet";
    const deployments = deploymentsData as unknown as Record<
      string,
      { registry?: string | null; rpcUrl?: string | null; networkPassphrase?: string | null }
    >;
    const cfg = deployments[net];
    const contractId = process.env.REGISTRY_CONTRACT_ID || cfg?.registry || "";
    const regSource =
      deps?.registry ??
      new AnchorRegistry({
        rpcUrl:
          process.env.SOROBAN_RPC_URL ||
          cfg?.rpcUrl ||
          (net === "public"
            ? "https://mainnet.sorobanrpc.com"
            : "https://soroban-testnet.stellar.org"),
        contractId,
        networkPassphrase:
          cfg?.networkPassphrase ?? (net === "public" ? Networks.PUBLIC : Networks.TESTNET),
      });
    let attestation: AnchorAttestation;
    try {
      attestation = await regSource.getAnchor(domain);
    } catch (e) {
      console.error(
        `✗ failed to read registry attestation for "${domain}": ${e instanceof Error ? e.message : String(e)}`,
      );
      return EXIT_FAILED;
    }

    const sep31Passed =
      attestation.seps.includes(31) && attestation.probesPassed.includes("sep31_info");
    if (!sep31Passed && !allowNotRunnable) {
      console.error(
        `✗ anchor "${domain}" does not attest serving SEP-31 (requires SEP-31 advertised and sep31_info probe passed). Consider SEP-6 or SEP-24 support, or re-run with --allow-not-runnable.`,
      );
      return EXIT_FAILED;
    }

    let yamlText: string;
    try {
      yamlText = manifestFromAttestation(attestation, {
        sourceAsset,
        network,
        allowNotRunnable,
      });
    } catch (e) {
      console.error(
        `✗ failed to scaffold manifest from registry: ${e instanceof Error ? e.message : String(e)}`,
      );
      return EXIT_FAILED;
    }

    if (outFile) {
      writeFileSync(outFile, yamlText, "utf8");
      console.log(`✓ wrote manifest for ${domain} to ${outFile}`);
    } else {
      process.stdout.write(yamlText);
    }
    return EXIT_OK;
  }

  const result = await probeAnchor(domain);
  const toml = result.toml ?? "";

  const sep31Advertised =
    (result.seps & sepBit(31)) !== 0 || tomlValue(toml, "DIRECT_PAYMENT_SERVER") !== undefined;
  if (!sep31Advertised && !allowNotRunnable) {
    console.error(
      `✗ anchor "${domain}" does not advertise SEP-31 (DIRECT_PAYMENT_SERVER). Consider SEP-6 or SEP-24 support, or re-run with --allow-not-runnable.`,
    );
    return EXIT_FAILED;
  }

  let yamlText: string;
  try {
    yamlText = manifestFromProbe(result, toml, {
      sourceAsset,
      network,
      allowNotRunnable,
    });
  } catch (e) {
    console.error(
      `✗ failed to scaffold manifest: ${e instanceof Error ? e.message : String(e)}`,
    );
    return EXIT_FAILED;
  }

  if (outFile) {
    writeFileSync(outFile, yamlText, "utf8");
    console.log(`✓ wrote manifest for ${domain} to ${outFile}`);
  } else {
    process.stdout.write(yamlText);
  }
  return EXIT_OK;
}
