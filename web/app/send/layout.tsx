import type { ReactNode } from "react";
import { TestnetBanner } from "@/components/send/TestnetBanner";

// Every screen under /send renders inside this layout, so the testnet banner is
// on all of them. The root layout already provides <main>; this is a plain
// wrapper so the page has exactly one main landmark.
export default function SendLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-8">
      <TestnetBanner />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
