import { NextResponse } from "next/server";
import { getDailySummaryData } from "@/lib/rates";

// GET /api/rates/daily-summary
//
// Returns 30-day rate history for currency pairs, with:
// - Reference rates (mid-market benchmarks)
// - Anchor-specific rates (with explicit nulls for gaps where no data was collected)
// - P25 stability band used for router estimates (RFC 0004)
//
// Optional query param:
//   ?pair=USDC/USD or ?pair=USDC/iso4217:USD to filter to a single pair.

export async function GET(req: Request) {
  const url = new URL(req.url);
  const pairParam = url.searchParams.get("pair")?.trim().toLowerCase();

  const data = getDailySummaryData();

  if (pairParam) {
    const matched = data.pairs.find(
      (p) =>
        p.pair.toLowerCase() === pairParam ||
        p.displayPair.toLowerCase() === pairParam ||
        p.pair.toLowerCase().replace("iso4217:", "") === pairParam,
    );

    if (!matched) {
      return NextResponse.json(
        {
          error: "pair_not_found",
          message: `No rate history found for pair '${pairParam}'`,
        },
        { status: 404 },
      );
    }

    return NextResponse.json({
      pairs: [matched],
    });
  }

  return NextResponse.json(data);
}
