// Long-running rate collector process with a 15-minute schedule (#593, RFC 0004 §3).
//
// Runs the rate history collectors every 15 minutes and writes what they read into
// Postgres (`rate_samples`), with startup jitter, an overlap guard that skips a run while
// the previous one is still going, and graceful shutdown on SIGTERM / SIGINT.
//
// Steps, in order:
//
//   sep38_prices  `pollSep38Prices` (#590). Polls the SEP-38 indicative prices of every
//                 anchor in the on-chain registry for STELLAR_NETWORK whose `sep38_quote`
//                 probe passed on a fresh attestation, plus any RATE_COLLECTOR_SEP38_ANCHORS.
//                 Writes `sep38_price` samples tagged with the anchor domain.
//   dex_trades    `collectDexTrades` (#591). Reads Horizon `/trade_aggregations` for every
//                 pair in config/dex-pairs.json (each pair names its own network) over the
//                 last 24 hours of complete 15-minute buckets. Writes `dex_trade` samples.
//                 Re-reading buckets already stored is a no-op, so a restart or a missed
//                 run backfills without duplicating anything.
//
// Every sample goes through `PostgresRateHistoryStore.recordFlaggingOutliers` (#602), so an
// outlier is stored but flagged. A step with nothing to read (no registry and no anchors
// for SEP-38, no pairs for the DEX) is left out rather than run empty.
//
// The collector reads only public prices: it holds no keys and moves no funds.
//
// Usage:
//   DATABASE_URL=postgres://... pnpm rate:collector
//
// Environment variables:
//   DATABASE_URL=postgres://...                  # required; migrated on start
//   STELLAR_NETWORK=testnet                      # testnet | public; registry + SEP-38 network
//   RATE_COLLECTOR_SEP38_ANCHORS=a.com,b.org     # extra anchors to poll (optional)
//   RATE_COLLECTOR_DEX_PAIRS=config/dex-pairs.json
//   RATE_COLLECTOR_INTERVAL_MS=900000            # 15 minutes (default)
//   RATE_COLLECTOR_INTERVAL_SECONDS=900          # alternative to the above
//   RATE_COLLECTOR_JITTER_MS=5000                # 0 to 5 seconds jitter (default)
//   RATE_COLLECTOR_RUN_ON_START=1                # run on startup (default 1)

import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { AnchorRegistry } from "@corridor/registry";
import {
  RateCollectorLoop,
  PostgresRateHistoryStore,
  RATE_NETWORKS,
  DEX_TRADE_RESOLUTION_15M,
  collectDexTrades,
  consoleLogger,
  loadDexPairsConfig,
  migrate,
  parseCollectorInterval,
  parseCollectorJitter,
  pollSep38Prices,
  type CollectorStep,
  type DexPairConfig,
  type RateNetwork,
  type RateSampleInput,
  type RateSampleRecorder,
  type Sep38AttestationSource,
} from "@corridor/engine";

/** How far back each DEX run re-reads, so a missed run or a restart is backfilled. */
const DEX_LOOKBACK_MS = 24 * 60 * 60 * 1000;

interface Deployments {
  [network: string]: {
    networkPassphrase: string;
    rpcUrl: string;
    registry: string | null;
  };
}

function repoPath(p: string): string {
  return isAbsolute(p) ? p : fileURLToPath(new URL(`../${p}`, import.meta.url));
}

function parseNetwork(raw: string | undefined): RateNetwork {
  const network = raw ?? "testnet";
  if (!(RATE_NETWORKS as readonly string[]).includes(network)) {
    throw new Error(
      `STELLAR_NETWORK must be testnet or public, got ${JSON.stringify(network)}`,
    );
  }
  return network as RateNetwork;
}

/** The on-chain registry for a network, or undefined when none is deployed there. */
function registryFor(network: RateNetwork): Sep38AttestationSource | undefined {
  const deployments = JSON.parse(
    readFileSync(repoPath("contracts/deployments.json"), "utf8"),
  ) as Deployments;
  const cfg = deployments[network];
  if (!cfg?.registry) return undefined;
  return new AnchorRegistry({
    rpcUrl: cfg.rpcUrl,
    contractId: cfg.registry,
    networkPassphrase: cfg.networkPassphrase,
  });
}

function sep38Step(
  network: RateNetwork,
  store: RateSampleRecorder,
  registry: Sep38AttestationSource | undefined,
  anchors: readonly string[],
): CollectorStep {
  return {
    name: "sep38_prices",
    run: async () => {
      const result = await pollSep38Prices({
        network,
        store,
        registry,
        anchors,
        logger: consoleLogger,
      });
      return {
        collected: result.recorded,
        duplicates: result.duplicates,
        anchors: result.anchors.length,
        anchorsFailed: result.anchorsFailed,
        ...(result.registryError ? { registryError: result.registryError } : {}),
        message: `stored ${result.recorded} SEP-38 prices from ${result.anchors.length} anchors (${result.anchorsFailed} failed)`,
      };
    },
  };
}

function dexStep(pairs: readonly DexPairConfig[], store: RateSampleRecorder): CollectorStep {
  return {
    name: "dex_trades",
    run: async () => {
      // Only complete buckets: the one in progress would be stored with a partial close
      // and never corrected, because the store keeps the first sample at an instant.
      const endTime =
        Math.floor(Date.now() / DEX_TRADE_RESOLUTION_15M) * DEX_TRADE_RESOLUTION_15M;
      const results = await collectDexTrades(pairs, store, {
        startTime: endTime - DEX_LOOKBACK_MS,
        endTime,
      });
      const collected = results.reduce((n, r) => n + r.inserted, 0);
      const read = results.reduce((n, r) => n + r.samples.length, 0);
      consoleLogger.log("info", "corridor.rate_collector.dex.run_completed", {
        pairs: results.map((r) => ({
          network: r.pair.network,
          base: r.pair.base,
          counter: r.pair.counter,
          buckets: r.samples.length,
          inserted: r.inserted,
        })),
      });
      return {
        collected,
        read,
        pairs: results.length,
        message: `stored ${collected} new DEX prices (${read} buckets read) for ${results.length} pairs`,
      };
    },
  };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("✗ DATABASE_URL is required: the collector writes rate samples to Postgres");
    process.exit(2);
  }
  const network = parseNetwork(process.env.STELLAR_NETWORK);
  const intervalMs = parseCollectorInterval(
    process.env.RATE_COLLECTOR_INTERVAL_MS,
    process.env.RATE_COLLECTOR_INTERVAL_SECONDS,
  );
  const maxJitterMs = parseCollectorJitter(process.env.RATE_COLLECTOR_JITTER_MS);
  const runOnStart =
    process.env.RATE_COLLECTOR_RUN_ON_START !== "0" &&
    process.env.RATE_COLLECTOR_RUN_ON_START !== "false";
  const sep38Anchors = (process.env.RATE_COLLECTOR_SEP38_ANCHORS ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d !== "");
  const dexPairsPath = repoPath(
    process.env.RATE_COLLECTOR_DEX_PAIRS || "config/dex-pairs.json",
  );
  const dexPairs = loadDexPairsConfig(dexPairsPath);
  const registry = registryFor(network);

  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl });
  await migrate(pool);
  const history = new PostgresRateHistoryStore(pool);
  const store: RateSampleRecorder = {
    record: async (sample: RateSampleInput) =>
      (await history.recordFlaggingOutliers(sample)).stored,
  };

  const steps: CollectorStep[] = [];
  if (registry || sep38Anchors.length > 0) {
    steps.push(sep38Step(network, store, registry, sep38Anchors));
  } else {
    console.log(
      `• sep38_prices: skipped (no registry deployed on ${network} and RATE_COLLECTOR_SEP38_ANCHORS is empty)`,
    );
  }
  if (dexPairs.length > 0) {
    steps.push(dexStep(dexPairs, store));
  } else {
    console.log(`• dex_trades: skipped (no pairs in ${dexPairsPath})`);
  }
  if (steps.length === 0) {
    await pool.end();
    console.error("✗ nothing to collect: configure a SEP-38 source or DEX pairs");
    process.exit(2);
  }

  const loop = new RateCollectorLoop({
    intervalMs,
    maxJitterMs,
    steps,
    logger: consoleLogger,
    runOnStart,
  });

  console.log(`\n✓ Rate collector loop initialized`);
  console.log(`  interval:    ${intervalMs} ms (${intervalMs / 1000 / 60}m)`);
  console.log(`  max jitter:  ${maxJitterMs} ms`);
  console.log(`  run on boot: ${runOnStart ? "yes" : "no"}`);
  console.log(
    `  network:     ${network} (SEP-38 registry: ${registry ? "on-chain" : "none"})`,
  );
  console.log(`  dex pairs:   ${dexPairs.length} from ${dexPairsPath}`);
  console.log(`  steps:       ${steps.map((s) => s.name).join(", ")}\n`);

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      console.log(`\n${sig} received, stopping rate collector…`);
      void loop
        .stop()
        .then(() => pool.end())
        .then(() => {
          console.log("✓ Rate collector stopped cleanly.");
          process.exit(0);
        });
    });
  }

  loop.start();
}

main().catch((err) => {
  console.error("Fatal error in rate collector:", err);
  process.exit(1);
});
