import { ShieldAlert } from "lucide-react";

/**
 * Permanent, non-dismissible testnet banner for the reference send application
 * (RFC 0004 §6, Issue #684).
 *
 * Renders on every screen under `/send` to ensure senders are permanently
 * aware that the application operates strictly on Stellar Testnet with no
 * real funds.
 */
export function TestnetBanner() {
  return (
    <aside
      role="alert"
      aria-label="Testnet Notice"
      className="flex w-full items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900 shadow-sm dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300 sm:items-center"
    >
      <ShieldAlert size={20} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400 sm:mt-0" />
      <div className="min-w-0 flex-1 text-xs sm:text-sm">
        <p className="font-semibold text-amber-950 dark:text-amber-200">
          Testnet only — no real money
        </p>
        <p className="mt-0.5 text-amber-800 dark:text-amber-300/90">
          This reference send application exercises <code>@corridor/service</code> on the Stellar
          Testnet. No real fiat or cryptocurrency is transferred. All transactions settle using
          testnet accounts and test tokens.
        </p>
      </div>
    </aside>
  );
}
