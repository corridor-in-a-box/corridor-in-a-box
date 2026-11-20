import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadCorridor, type Corridor } from "@corridor/manifest";
import { isSettleableAmount } from "@corridor/types";
import { rankRoutes, type RankedRoute, type RouteQuery } from "@corridor/router";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export interface RoutesCommandOptions {
  amount: string;
  to: string;
  country: string;
  offline: boolean;
  network?: "public" | "testnet";
  dir: string;
  json: boolean;
}

export type ParseRoutesResult =
  { ok: true; value: RoutesCommandOptions } | { ok: false; error: string };

export const ROUTES_USAGE =
  "usage: corridor routes --amount <amount> --to <asset> --country <country> [--offline] [--network <public|testnet>] [--dir <dir>] [--json]";

export function parseRoutesArgs(args: string[]): ParseRoutesResult {
  let amount: string | undefined;
  let to: string | undefined;
  let country: string | undefined;
  let offline = false;
  let network: "public" | "testnet" | undefined;
  let dir = "corridors";
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--amount") {
      if (i + 1 >= args.length || args[i + 1]!.startsWith("--")) {
        return { ok: false, error: "error: --amount requires a value" };
      }
      amount = args[++i];
    } else if (arg.startsWith("--amount=")) {
      amount = arg.slice("--amount=".length);
    } else if (arg === "--to") {
      if (i + 1 >= args.length || args[i + 1]!.startsWith("--")) {
        return { ok: false, error: "error: --to requires a value" };
      }
      to = args[++i];
    } else if (arg.startsWith("--to=")) {
      to = arg.slice("--to=".length);
    } else if (arg === "--country") {
      if (i + 1 >= args.length || args[i + 1]!.startsWith("--")) {
        return { ok: false, error: "error: --country requires a value" };
      }
      country = args[++i];
    } else if (arg.startsWith("--country=")) {
      country = arg.slice("--country=".length);
    } else if (arg === "--offline") {
      offline = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--dir") {
      if (i + 1 >= args.length || args[i + 1]!.startsWith("--")) {
        return { ok: false, error: "error: --dir requires a value" };
      }
      dir = args[++i]!;
    } else if (arg.startsWith("--dir=")) {
      dir = arg.slice("--dir=".length);
    } else if (arg === "--network") {
      if (i + 1 >= args.length || args[i + 1]!.startsWith("--")) {
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
    } else if (arg.startsWith("--")) {
      return { ok: false, error: `error: unknown option "${arg}"` };
    } else {
      return { ok: false, error: `error: unexpected argument "${arg}"` };
    }
  }

  if (amount === undefined || amount === "") {
    return { ok: false, error: "error: --amount <amount> is required for routes" };
  }

  if (!isSettleableAmount(amount)) {
    return {
      ok: false,
      error: `error: --amount must be a positive decimal amount (got "${amount}")`,
    };
  }

  if (to === undefined || to.trim() === "") {
    return { ok: false, error: "error: --to <asset> is required for routes" };
  }

  if (country === undefined || country.trim() === "") {
    return { ok: false, error: "error: --country <country> is required for routes" };
  }

  return {
    ok: true,
    value: {
      amount,
      to: to.trim(),
      country: country.trim(),
      offline,
      network,
      dir,
      json,
    },
  };
}

export function loadCorridorsFromDir(dirPath: string): Corridor[] {
  try {
    const files = readdirSync(dirPath).filter((f) => f.endsWith(".corridor.yaml"));
    const corridors: Corridor[] = [];
    for (const file of files) {
      const fullPath = join(dirPath, file);
      const res = loadCorridor(fullPath);
      if (res.ok) {
        corridors.push(res.value);
      }
    }
    return corridors;
  } catch {
    return [];
  }
}

export function formatRoutesTable(
  query: RouteQuery,
  routes: readonly RankedRoute[],
  mode: "live" | "offline",
): string {
  if (routes.length === 0) {
    return `no matching routes found for ${query.amount} ${query.to} in ${query.country} (mode: ${mode})`;
  }

  const lines: string[] = [];
  lines.push(`routes for ${query.amount} ${query.to} -> ${query.country} (mode: ${mode}):`);
  lines.push("");

  const header = ["#", "CORRIDOR", "DEST ANCHOR", "PROTOCOL", "LABEL", "QUOTE", "REASONS"];
  const rows = routes.map((r) => [
    String(r.rank),
    r.corridorId,
    r.destDomain,
    r.protocol,
    r.label,
    r.quoteSource,
    r.reasons.join("; "),
  ]);

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => (row[i] ? (row[i] as string).length : 0))),
  );

  const formatLine = (cells: string[]) =>
    cells
      .map((cell, i) => {
        // Last column shouldn't be padded excessively
        if (i === cells.length - 1) return cell;
        return cell.padEnd(widths[i] ?? 0);
      })
      .join("  ")
      .trimEnd();

  lines.push(formatLine(header));
  lines.push(
    formatLine(widths.map((w, i) => (i === widths.length - 1 ? "-------" : "-".repeat(w)))),
  );
  for (const row of rows) {
    lines.push(formatLine(row));
  }

  return lines.join("\n");
}

export async function routesCommand(argv: string[]): Promise<number> {
  const parsed = parseRoutesArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    return EXIT_USAGE;
  }

  const { amount, to, country, offline, dir, json } = parsed.value;
  const corridors = loadCorridorsFromDir(dir);

  const query: RouteQuery = {
    amount,
    to,
    country,
    offline,
  };

  const ranked = await rankRoutes(query, corridors);

  if (json) {
    console.log(JSON.stringify(ranked, null, 2));
    return EXIT_OK;
  }

  const mode = offline ? "offline" : "live";
  console.log(formatRoutesTable(query, ranked, mode));
  return EXIT_OK;
}
