import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { corridors } from "@/lib/corridors";
import { sendOptionsFromCorridors } from "@/lib/send";
import { SendAppFixture } from "./SendAppFixture";

// The send app with its three seams wired, for web/e2e/accessibility.spec.ts
// only (#692). /send renders <SendApp> without a route planner, a field loader
// or a sender, because @corridor/service offers none of them yet, so on /send
// the flow stops after the first step. This page wires all three to plain
// fetches that the Playwright spec answers with `page.route`, which lets axe
// see every step: routes, the locked-price countdown, recipient details,
// sending, sent and each failure screen.
//
// Nothing here is served unless the server was started with
// SEND_A11Y_FIXTURE=1 (web/playwright.config.ts does that). Any other server
// answers 404, so a deployment never shows it.

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Send (accessibility fixture) — corridor-in-a-box",
  robots: { index: false, follow: false },
};

const { destinations, sourceAssets } = sendOptionsFromCorridors(corridors);

export default function SendA11yFixturePage() {
  if (process.env.SEND_A11Y_FIXTURE !== "1") notFound();
  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-3xl font-bold tracking-tight text-balance">Send a testnet payment</h1>
        <p className="mt-2 max-w-prose text-secondary-text">
          Choose an amount and a destination, compare the routes with their price labels, then
          fill in exactly what the receiving anchor asks for.
        </p>
      </header>

      <SendAppFixture destinations={destinations} sourceAssets={sourceAssets} />
    </div>
  );
}
