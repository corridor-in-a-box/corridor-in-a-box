import { NextResponse } from "next/server";
import { proxyCreatePayment, sendProxyConfigFromEnv } from "@/lib/send-proxy";

// POST /api/send/payments: the send app's call to @corridor/service.
// The service API key is read here, on the server, and never sent to the browser.
export async function POST(req: Request) {
  const config = sendProxyConfigFromEnv(process.env);
  const result = await proxyCreatePayment(config, await req.text());
  return NextResponse.json(result.body, { status: result.status });
}
