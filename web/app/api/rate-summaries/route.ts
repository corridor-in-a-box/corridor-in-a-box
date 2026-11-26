import { NextResponse } from "next/server";
import { fetchRateSummaries } from "@/lib/rate-summaries";

export const dynamic = "force-static";
export const revalidate = 3600;

export async function GET() {
  const snapshot = await fetchRateSummaries();
  const status = snapshot.ok ? 200 : snapshot.configured ? 502 : 503;
  return NextResponse.json(snapshot, { status });
}
