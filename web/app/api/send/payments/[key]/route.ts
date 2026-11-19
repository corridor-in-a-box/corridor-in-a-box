import { NextResponse } from "next/server";
import { proxyGetPayment, sendProxyConfigFromEnv } from "@/lib/send-proxy";

// GET /api/send/payments/:key: read one run back from @corridor/service,
// with the API key attached on the server.
export async function GET(_req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const result = await proxyGetPayment(sendProxyConfigFromEnv(process.env), key);
  return NextResponse.json(result.body, { status: result.status });
}
