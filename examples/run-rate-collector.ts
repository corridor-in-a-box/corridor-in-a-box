// Long-running rate collector process with a 15-minute schedule (#593, RFC 0004 §3).
//
// Samples indicative quotes and DEX trade aggregations every 15 minutes,
// with startup jitter to prevent thundering herds, an overlap guard that skips
// a run if the previous one is still in flight, and graceful shutdown on SIGTERM / SIGINT.
//
// Usage:
//   pnpm rate:collector
//   tsx examples/run-rate-collector.ts
//
// Environment variables:
//   RATE_COLLECTOR_INTERVAL_MS=900000       # 15 minutes (default)
//   RATE_COLLECTOR_JITTER_MS=5000           # 0 to 5 seconds jitter (default)
//   RATE_COLLECTOR_RUN_ON_START=1           # run on startup (default 1)
//   HORIZON_URL=https://...                 # Horizon endpoint

import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadCorridor, type Corridor } from "@corridor/manifest";
import {
  RateCollectorLoop,
  parseCollectorInterval,
  parseCollectorJitter,
  consoleLogger,
  type CollectorStep,
  type CollectorStepResult,
} from "@corridor/engine";

function corridorsDir(): string {
  const d = process.env.CORRIDORS_DIR ?? "corridors";
  return d.startsWith("/") ? d : fileURLToPath(new URL(`../${d}`, import.meta.url));
}

function loadCorridors(): Corridor[] {
  const dir = corridorsDir();
  const corridors: Corridor[] = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".corridor.yaml")) continue;
      const loaded = loadCorridor(join(dir, f));
      if (loaded.ok) {
        corridors.push(loaded.value);
      }
    }
  } catch {
    // Directory may not exist in minimal environments
  }
  return corridors;
}

/**
 * Builds collector steps for standard rates, DEX trade aggregations, and anchor corridors.
 */
function buildCollectorSteps(horizonUrl: string): CollectorStep[] {
  const steps: CollectorStep[] = [];

  // Step 1: Corridor quote checks
  steps.push({
    name: "corridor_quotes",
    run: async (): Promise<CollectorStepResult> => {
      const corridors = loadCorridors();
      let quoted = 0;
      for (const corridor of corridors) {
        if (corridor.fx.quote_source === "sep38" || corridor.fx.quote_source === "native") {
          quoted++;
        }
      }
      return {
        collected: quoted,
        corridors: corridors.length,
        message: `checked ${corridors.length} corridors (${quoted} quote-capable)`,
      };
    },
  });

  // Step 2: Stellar DEX 15-minute trade aggregations
  steps.push({
    name: "dex_trade_aggregations",
    run: async (): Promise<CollectorStepResult> => {
      const url = new URL(`${horizonUrl.replace(/\/+$/, "")}/trade_aggregations`);
      url.searchParams.set("base_asset_type", "native");
      url.searchParams.set("counter_asset_type", "credit_alphanum4");
      url.searchParams.set("counter_asset_code", "USDC");
      url.searchParams.set(
        "counter_asset_issuer",
        "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      );
      url.searchParams.set("resolution", "900000"); // 15 minutes
      url.searchParams.set("limit", "5");
      url.searchParams.set("order", "desc");

      try {
        const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) {
          return {
            collected: 0,
            message: `Horizon trade_aggregations returned HTTP ${res.status}`,
          };
        }
        const data = (await res.json()) as { _embedded?: { records?: unknown[] } };
        const records = data._embedded?.records ?? [];
        return {
          collected: records.length,
          message: `fetched ${records.length} 15m DEX trade aggregation buckets`,
        };
      } catch (err) {
        return {
          collected: 0,
          message: `Horizon query skipped: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  });

  return steps;
}

async function main(): Promise<void> {
  const intervalMs = parseCollectorInterval(
    process.env.RATE_COLLECTOR_INTERVAL_MS,
    process.env.RATE_COLLECTOR_INTERVAL_SECONDS,
  );
  const maxJitterMs = parseCollectorJitter(process.env.RATE_COLLECTOR_JITTER_MS);
  const runOnStart =
    process.env.RATE_COLLECTOR_RUN_ON_START !== "0" &&
    process.env.RATE_COLLECTOR_RUN_ON_START !== "false";
  const horizonUrl = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";

  const steps = buildCollectorSteps(horizonUrl);

  const loop = new RateCollectorLoop({
    intervalMs,
    maxJitterMs,
    steps,
    logger: consoleLogger,
    runOnStart,
  });

  console.log(`\n✓ Rate collector loop initialized`);
  console.log(`  interval:   ${intervalMs} ms (${intervalMs / 1000 / 60}m)`);
  console.log(`  max jitter: ${maxJitterMs} ms`);
  console.log(`  run on boot:${runOnStart ? " yes" : " no"}`);
  console.log(`  horizon:    ${horizonUrl}`);
  console.log(`  steps:      ${steps.map((s) => s.name).join(", ")}\n`);

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      console.log(`\n${sig} received, stopping rate collector…`);
      void loop.stop().then(() => {
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
