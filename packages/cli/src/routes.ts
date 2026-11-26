// corridor routes — what would the planner offer for this payment, and why?
//
// Runs the RFC 0004 planner (`planRoutes` from @corridor/router, the same
// composition @corridor/service serves as POST /routes) over the manifests in a
// directory and prints the offered options in rank order, then every matching
// corridor that was dropped, with the reason. Nothing is sent: no transaction is
// opened and no quote is accepted.
//
// Where the evidence and prices come from:
//   - registry:   the AnchorRegistry for `--network` (default testnet), from
//                 contracts/deployments.json, with the same SOROBAN_RPC_URL /
//                 REGISTRY_CONTRACT_ID overrides `plan --registry` and `canary`
//                 honour. No registry on that network means no plan: the planner
//                 never offers an anchor without evidence.
//   - indicative: the anchor's SEP-38 GET /price. Skipped with `--offline`.
//   - estimated:  rate history in Postgres, when DATABASE_URL is set.
//   - locked:     needs an authenticated SEP-38 quote adapter, which this command
//                 does not wire, so `locked` is always dropped with that reason.
// A label with no source is dropped with the reason; a price is never invented.
//
// `--offline` contacts no anchor: only the manifests, the registry and the local
// rate history are read, so the only price an offline plan can show is
// `estimated`.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Networks } from "@stellar/stellar-sdk";
import { loadCorridor, type Corridor } from "@corridor/manifest";
import { AnchorRegistry } from "@corridor/registry";
import {
  ALL_PRICE_LABELS,
  planRoutes,
  type AttestationSourceLike,
  type PriceLabel,
  type RateHistorySource,
  type RoutePlan,
  type RoutePolicy,
  type RouteRequest,
} from "@corridor/router";
import { PostgresRateHistoryStore, type RateSampleRecord } from "@corridor/engine";
import { isSettleableAmount } from "@corridor/types";
import deploymentsData from "../../../contracts/deployments.json";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/** Networks `--network` accepts, matching the keys of contracts/deployments.json. */
export type RoutesNetwork = "testnet" | "public";

export const ROUTES_USAGE =
  "usage: corridor routes --amount <amount> --to <asset> --country <CC> [--from <asset>] " +
  "[--payout-method <method>] [--labels locked,indicative,estimated] [--margin-bps <n>] " +
  "[--window-days <n>] [--guarantee-estimates] [--network testnet|public] [--dir <dir>] " +
  "[--offline] [--json]";

/** Same bounds POST /routes applies to the request. */
const MAX_ASSET_ID = 128;
const MAX_PAYOUT_METHOD = 64;
const MAX_ESTIMATE_WINDOW_DAYS = 90;
const COUNTRY_PATTERN = /^[A-Za-z]{2}$/;

export interface RoutesArgs {
  readonly request: RouteRequest;
  readonly network: RoutesNetwork;
  readonly dir: string;
  readonly offline: boolean;
  readonly json: boolean;
}

export type ParseRoutesResult =
  | { readonly ok: true; readonly value: RoutesArgs }
  | { readonly ok: false; readonly error: string };

/** A bare ISO 4217 code (`NGN`) means the SEP-38 asset `iso4217:NGN`; anything else is kept. */
export function toDestAsset(raw: string): string {
  const v = raw.trim();
  return /^[A-Za-z]{3}$/.test(v) ? `iso4217:${v.toUpperCase()}` : v;
}

function parseInteger(raw: string, min: number, max: number): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number.parseInt(raw, 10);
  return n >= min && n <= max ? n : undefined;
}

/** Parse `corridor routes` arguments into an RFC 0004 RouteRequest plus CLI options. */
export function parseRoutesArgs(args: readonly string[]): ParseRoutesResult {
  const values: Record<string, string> = {};
  let offline = false;
  let json = false;
  let guaranteeEstimates = false;
  const valued = new Set([
    "amount",
    "from",
    "to",
    "country",
    "payout-method",
    "labels",
    "margin-bps",
    "window-days",
    "network",
    "dir",
  ]);
  const fail = (error: string): ParseRoutesResult => ({ ok: false, error });

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--offline") offline = true;
    else if (arg === "--json") json = true;
    else if (arg === "--guarantee-estimates") guaranteeEstimates = true;
    else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = arg.slice(2, eq === -1 ? undefined : eq);
      if (!valued.has(name)) return fail(`error: unknown option "${arg}"`);
      if (eq !== -1) {
        values[name] = arg.slice(eq + 1);
      } else {
        const next = args[i + 1];
        if (next === undefined || next.startsWith("--")) {
          return fail(`error: --${name} requires a value`);
        }
        values[name] = next;
        i++;
      }
    } else {
      return fail(`error: unexpected argument "${arg}"`);
    }
  }

  const amount = values["amount"];
  if (amount === undefined || amount === "") {
    return fail("error: --amount <amount> is required for routes");
  }
  if (!isSettleableAmount(amount)) {
    return fail(`error: --amount must be a positive decimal amount (got "${amount}")`);
  }
  const to = values["to"]?.trim();
  if (!to) return fail("error: --to <asset> is required for routes");
  const destAsset = toDestAsset(to);
  if (destAsset.length > MAX_ASSET_ID) {
    return fail(`error: --to must be 1-${MAX_ASSET_ID} characters`);
  }
  const country = values["country"]?.trim();
  if (!country) return fail("error: --country <CC> is required for routes");
  if (!COUNTRY_PATTERN.test(country)) {
    return fail(`error: --country must be an ISO 3166-1 alpha-2 code (got "${country}")`);
  }
  // Every shipped manifest sends USDC; --from names another source or bridge asset.
  const from = values["from"]?.trim() ?? "USDC";
  if (from.length === 0 || from.length > MAX_ASSET_ID) {
    return fail(`error: --from must be 1-${MAX_ASSET_ID} characters`);
  }
  const payoutMethod = values["payout-method"]?.trim();
  if (
    payoutMethod !== undefined &&
    (payoutMethod.length === 0 || payoutMethod.length > MAX_PAYOUT_METHOD)
  ) {
    return fail(`error: --payout-method must be 1-${MAX_PAYOUT_METHOD} characters`);
  }

  const network = values["network"] ?? "testnet";
  if (network !== "testnet" && network !== "public") {
    return fail(`error: --network must be "testnet" or "public" (got "${network}")`);
  }

  const policy: {
    allowedLabels?: PriceLabel[];
    guaranteeEstimates?: boolean;
    estimateWindowDays?: number;
    estimateMarginBps?: number;
  } = {};
  if (values["labels"] !== undefined) {
    const labels = values["labels"].split(",").map((l) => l.trim());
    for (const label of labels) {
      if (!(ALL_PRICE_LABELS as readonly string[]).includes(label)) {
        return fail(
          `error: --labels takes locked, indicative and/or estimated (got "${label}")`,
        );
      }
    }
    if (new Set(labels).size !== labels.length) {
      return fail("error: --labels must not repeat a label");
    }
    policy.allowedLabels = labels as PriceLabel[];
  }
  if (values["margin-bps"] !== undefined) {
    const bps = parseInteger(values["margin-bps"], 0, 9_999);
    if (bps === undefined)
      return fail("error: --margin-bps must be an integer from 0 to 9999");
    policy.estimateMarginBps = bps;
  }
  if (values["window-days"] !== undefined) {
    const days = parseInteger(values["window-days"], 1, MAX_ESTIMATE_WINDOW_DAYS);
    if (days === undefined) {
      return fail(
        `error: --window-days must be an integer from 1 to ${MAX_ESTIMATE_WINDOW_DAYS}`,
      );
    }
    policy.estimateWindowDays = days;
  }
  if (guaranteeEstimates) policy.guaranteeEstimates = true;

  if (offline && policy.allowedLabels && !policy.allowedLabels.includes("estimated")) {
    return fail(
      "error: --offline contacts no anchor, so it can only show estimated prices; add estimated to --labels",
    );
  }

  return {
    ok: true,
    value: {
      request: {
        sourceAmount: { asset: from, amount },
        destAsset,
        destCountry: country.toUpperCase(),
        ...(payoutMethod !== undefined ? { payoutMethod } : {}),
        ...(Object.keys(policy).length > 0 ? { policy: policy as RoutePolicy } : {}),
      },
      network,
      dir: values["dir"] ?? "corridors",
      offline,
      json,
    },
  };
}

export interface LoadedCorridors {
  readonly corridors: readonly Corridor[];
  /** Manifests that did not load, with why. They are not planned over. */
  readonly skipped: ReadonlyArray<{ readonly file: string; readonly reason: string }>;
}

/** Load every `*.corridor.yaml` in `dir`, in file-name order. Throws if `dir` cannot be read. */
export function loadCorridorsFromDir(dir: string): LoadedCorridors {
  const corridors: Corridor[] = [];
  const skipped: { file: string; reason: string }[] = [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".corridor.yaml"))
    .sort();
  for (const file of files) {
    const loaded = loadCorridor(join(dir, file));
    if (loaded.ok) corridors.push(loaded.value);
    else skipped.push({ file, reason: loaded.error.message });
  }
  return { corridors, skipped };
}

/** The part of PostgresRateHistoryStore rate history needs. */
export interface RateSampleReader {
  list(filter: {
    sellAsset: string;
    buyAsset: string;
    anchorDomain: string;
    since: number;
  }): Promise<readonly Pick<RateSampleRecord, "rate" | "sampledAt" | "outlier">[]>;
}

/**
 * Rate history for `estimated` prices, read from stored samples. Only the
 * receiving anchor's own prices count (its SEP-38 prices and the business's
 * completed payments through it: the sources that carry an anchor domain), so a
 * DEX or reference rate never stands in for an anchor's. Outliers are passed
 * through flagged; the estimate leaves them out.
 */
export function rateHistoryFrom(reader: RateSampleReader): RateHistorySource {
  return async ({ receivingDomain, sellAsset, buyAsset, sinceMs }) => {
    const rows = await reader.list({
      sellAsset,
      buyAsset,
      anchorDomain: receivingDomain,
      since: sinceMs,
    });
    return rows.map((r) => ({ rate: r.rate, timestampMs: r.sampledAt, outlier: r.outlier }));
  };
}

/** What a plan needs from outside. Tests pass fakes; `routesCommand` wires the real ones. */
export interface RoutesDeps {
  readonly registry: AttestationSourceLike;
  /** fetch for SEP-38 GET /price. Never called with `--offline`. */
  readonly fetch?: typeof fetch;
  readonly rateHistory?: RateHistorySource;
  readonly now?: () => number;
  readonly pricingDeadlineMs?: number;
}

/** A fetch that refuses: `--offline` must never reach an anchor. */
const offlineFetch = (async () => {
  throw new Error("--offline: anchors are not contacted");
}) as typeof fetch;

/**
 * Plan routes for the parsed arguments. `--offline` narrows the allowed labels
 * to `estimated` (the only one that needs no anchor) and swaps in a fetch that
 * refuses, so no code path can reach an anchor.
 */
export async function planCliRoutes(
  args: Pick<RoutesArgs, "request" | "offline">,
  corridors: readonly Corridor[],
  deps: RoutesDeps,
): Promise<RoutePlan> {
  const request: RouteRequest = args.offline
    ? { ...args.request, policy: { ...args.request.policy, allowedLabels: ["estimated"] } }
    : args.request;
  const fetchImpl = args.offline ? offlineFetch : deps.fetch;
  return planRoutes(
    request,
    corridors,
    {
      registry: deps.registry,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      ...(deps.rateHistory ? { rateHistory: deps.rateHistory } : {}),
      ...(deps.pricingDeadlineMs !== undefined
        ? { pricingDeadlineMs: deps.pricingDeadlineMs }
        : {}),
    },
    { now: deps.now ?? (() => Date.now()) },
  );
}

/** Context printed above the plan. */
export interface RoutesHeader {
  readonly network: RoutesNetwork;
  readonly registry: string;
  readonly offline: boolean;
  readonly rateHistory: boolean;
}

/** Render a plan for a terminal: offered options in rank order, then the dropped ones. */
export function formatRoutes(
  request: RouteRequest,
  plan: RoutePlan,
  header: RoutesHeader,
): string {
  const lines: string[] = [];
  const line = (s = "") => lines.push(s);
  line(
    `routes for ${request.sourceAmount.amount} ${request.sourceAmount.asset} -> ${request.destAsset} in ${request.destCountry}`,
  );
  line(`  registry:     ${header.registry} on ${header.network}`);
  line(
    `  prices:       ${
      header.offline
        ? "offline: no anchor contacted, estimated only"
        : "live: SEP-38 GET /price from each anchor"
    }${header.rateHistory ? "; rate history from DATABASE_URL" : "; no rate history (DATABASE_URL unset)"}`,
  );
  if (request.payoutMethod !== undefined) line(`  payout:       ${request.payoutMethod}`);
  line();

  if (plan.offered.length === 0) {
    line("offered: none");
  } else {
    line(`offered (${plan.offered.length}, best first):`);
    plan.offered.forEach((o, i) => {
      line(
        `  ${i + 1}. ${o.receivingDomain} (${o.corridorId}, ${o.protocol}) — ${o.price.label}`,
      );
      line(`     rate:           ${o.price.rate}`);
      line(`     recipient gets: ${o.recipientGets.amount} ${o.recipientGets.asset}`);
      if (o.fees) line(`     fees:           ${o.fees.amount} ${o.fees.asset}`);
      line(`     reliability:    ${o.reliability.toFixed(2)}`);
      for (const reason of o.reasons) line(`     - ${reason}`);
    });
  }

  if (plan.dropped.length > 0) {
    line();
    line(`dropped (${plan.dropped.length}):`);
    for (const d of plan.dropped) {
      line(`  - ${d.receivingDomain} (${d.corridorId}, ${d.protocol}): ${d.reason}`);
    }
  }
  if (plan.offered.length === 0 && plan.dropped.length === 0) {
    line();
    line(`no corridor in this directory pays ${request.destAsset} in ${request.destCountry}`);
  }
  return lines.join("\n");
}

interface DeploymentConfig {
  networkPassphrase?: string;
  rpcUrl?: string;
  registry?: string | null;
}

export type RegistryWiring =
  | {
      readonly ok: true;
      readonly contractId: string;
      readonly registry: AttestationSourceLike;
    }
  | { readonly ok: false; readonly error: string };

/**
 * The AnchorRegistry for `network`, from contracts/deployments.json with the
 * SOROBAN_RPC_URL / REGISTRY_CONTRACT_ID overrides, as `plan --registry` builds it.
 */
export function registryFor(
  network: RoutesNetwork,
  deployments: Readonly<Record<string, DeploymentConfig>> = deploymentsData as Record<
    string,
    DeploymentConfig
  >,
): RegistryWiring {
  const cfg = deployments[network];
  const contractId = process.env.REGISTRY_CONTRACT_ID || cfg?.registry;
  if (!contractId) {
    return {
      ok: false,
      error: `no registry deployed on ${network} (see contracts/deployments.json or set REGISTRY_CONTRACT_ID); routes are only offered with registry evidence`,
    };
  }
  try {
    return {
      ok: true,
      contractId,
      registry: new AnchorRegistry({
        rpcUrl:
          process.env.SOROBAN_RPC_URL || cfg?.rpcUrl || "https://soroban-testnet.stellar.org",
        contractId,
        networkPassphrase:
          cfg?.networkPassphrase ??
          (network === "public" ? Networks.PUBLIC : Networks.TESTNET),
      }),
    };
  } catch (e) {
    // A malformed REGISTRY_CONTRACT_ID throws in the constructor.
    return { ok: false, error: `registry ${contractId} on ${network}: ${message(e)}` };
  }
}

function message(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";
}

/** `corridor routes …`. 0 when at least one route is offered, 1 when none is, 2 on bad usage. */
export async function routesCommand(argv: readonly string[]): Promise<number> {
  const parsed = parseRoutesArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    console.error(ROUTES_USAGE);
    return EXIT_USAGE;
  }
  const args = parsed.value;

  let loaded: LoadedCorridors;
  try {
    loaded = loadCorridorsFromDir(args.dir);
  } catch (e) {
    console.error(`✗ cannot read corridor directory ${args.dir}: ${message(e)}`);
    return EXIT_FAILED;
  }
  for (const s of loaded.skipped) console.error(`• skipping ${s.file}: ${s.reason}`);

  const wiring = registryFor(args.network);
  if (!wiring.ok) {
    console.error(`✗ ${wiring.error}`);
    return EXIT_FAILED;
  }

  let closeDb: (() => Promise<void>) | undefined;
  let rateHistory: RateHistorySource | undefined;
  const connectionString = process.env.DATABASE_URL;
  if (connectionString) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString });
    closeDb = () => pool.end();
    rateHistory = rateHistoryFrom(new PostgresRateHistoryStore(pool));
  }

  let plan: RoutePlan;
  try {
    plan = await planCliRoutes(args, loaded.corridors, {
      registry: wiring.registry,
      ...(rateHistory ? { rateHistory } : {}),
    });
  } catch (e) {
    console.error(`✗ route planning failed: ${message(e)}`);
    return EXIT_FAILED;
  } finally {
    await closeDb?.();
  }

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          request: args.request,
          network: args.network,
          registry: wiring.contractId,
          offline: args.offline,
          offered: plan.offered,
          dropped: plan.dropped,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      formatRoutes(args.request, plan, {
        network: args.network,
        registry: wiring.contractId,
        offline: args.offline,
        rateHistory: rateHistory !== undefined,
      }),
    );
  }
  return plan.offered.length > 0 ? EXIT_OK : EXIT_FAILED;
}
