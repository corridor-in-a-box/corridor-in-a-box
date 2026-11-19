import type { ReactNode } from "react";
import { TestnetBanner } from "@/components/send/TestnetBanner";

export default function SendLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8">
      <TestnetBanner />
      <main className="w-full max-w-full overflow-x-hidden">{children}</main>
    </div>
  );
}
