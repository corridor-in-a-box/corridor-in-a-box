import Link from "next/link";
import { ArrowRight, FileText, Send, ShieldCheck, Zap } from "lucide-react";

export const metadata = {
  title: "Send Payment — corridor-in-a-box",
  description:
    "Reference Send Application: testnet-only sender interface to plan corridors, evaluate ranked quotes, specify recipient details, and watch payments settle.",
};

export default function SendPage() {
  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-primary-text">Send Payment</h1>
        <p className="mt-2 text-sm text-secondary-text">
          Reference send application (RFC 0004 §6). Exercise <code>@corridor/service</code> to plan
          routes, evaluate ranked quotes, collect destination fields, and verify end-to-end
          settlement on Stellar Testnet.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-blue-500/10 p-2 text-blue-600 dark:text-blue-400">
              <Zap size={20} />
            </div>
            <h2 className="text-lg font-semibold text-primary-text">Plan & Quote</h2>
          </div>
          <p className="mt-3 text-sm text-secondary-text">
            Compare live corridors against Anchor Platform endpoints. Filter routes by latency, fee,
            and price stability (locked, indicative, or estimated).
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-emerald-500/10 p-2 text-emerald-600 dark:text-emerald-400">
              <ShieldCheck size={20} />
            </div>
            <h2 className="text-lg font-semibold text-primary-text">Comply & Register</h2>
          </div>
          <p className="mt-3 text-sm text-secondary-text">
            SEP-12 customer registration and KYC field collection dynamically driven by anchor
            specifications without client-side hardcoding.
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-purple-500/10 p-2 text-purple-600 dark:text-purple-400">
              <Send size={20} />
            </div>
            <h2 className="text-lg font-semibold text-primary-text">Settle on Testnet</h2>
          </div>
          <p className="mt-3 text-sm text-secondary-text">
            Execute payment transactions with cryptographic signing, automatic sequence locking,
            and live Horizon confirmation.
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-amber-500/10 p-2 text-amber-600 dark:text-amber-400">
              <FileText size={20} />
            </div>
            <h2 className="text-lg font-semibold text-primary-text">Reconcile & Audit</h2>
          </div>
          <p className="mt-3 text-sm text-secondary-text">
            Track transaction statuses through SEP-31 polling and observe the immutable transition
            audit log from quotation to completion.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
        <h3 className="text-base font-semibold text-primary-text">Getting Started</h3>
        <p className="mt-2 text-sm text-secondary-text">
          Use the navigation links or the payments runner to initiate testnet transfers against
          the reference anchor or explore configured corridors.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Link
            href="/payments"
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
          >
            Open Payment Runner
            <ArrowRight size={16} />
          </Link>
          <Link
            href="/docs"
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-transparent px-4 py-2 text-sm font-medium text-primary-text transition-colors hover:bg-bg-subtle"
          >
            Read Documentation
          </Link>
        </div>
      </div>
    </div>
  );
}
