import { CircleCheck, AlertCircle, Clock, ExternalLink, ArrowRight } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import type { LatestRealRunResult } from "@/lib/latest-run";

export function LatestRealRun({ data }: { data: LatestRealRunResult }) {
  const { run, settle, trail, runUnavailable, settleUnavailable } = data;

  return (
    <Card className="flex flex-col gap-5 border-blue-500/20 bg-bg-subtle/50 p-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold">Latest real payment</h2>
            <span className="rounded-full border border-border bg-background px-2.5 py-0.5 text-xs font-medium text-secondary-text">
              testnet · self-hosted reference anchor · fiat payout simulated
            </span>
          </div>
          <p className="mt-1 text-sm text-secondary-text">
            The nightly reference run completes a real SEP-31 payment on Stellar testnet against an SDF Anchor Platform stack.
          </p>
        </div>

        <div>
          {runUnavailable ? (
            <Badge variant="warning">
              <Clock size={12} /> run status unavailable
            </Badge>
          ) : run?.displayStatus === "completed" ? (
            <Badge variant="success">
              <CircleCheck size={12} /> nightly run completed
            </Badge>
          ) : run?.displayStatus === "failed" ? (
            <Badge variant="danger">
              <AlertCircle size={12} /> nightly run failed
            </Badge>
          ) : run?.displayStatus === "held" ? (
            <Badge variant="warning">
              <AlertCircle size={12} /> nightly run held
            </Badge>
          ) : (
            <Badge variant="info">
              <Clock size={12} /> nightly run in progress
            </Badge>
          )}
        </div>
      </div>

      {/* State Machine Trail */}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-secondary-text">
          State Machine Trail
        </span>
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs">
          {trail.map((step, idx) => (
            <div key={step} className="flex items-center gap-1.5">
              <span
                className={`rounded px-2 py-1 ${
                  step === "completed"
                    ? "bg-green-500/10 font-medium text-green-700 dark:text-green-400"
                    : step === "failed"
                      ? "bg-red-500/10 font-medium text-red-700 dark:text-red-400"
                      : step === "held"
                        ? "bg-yellow-500/10 font-medium text-yellow-700 dark:text-yellow-400"
                        : "bg-background text-secondary-text"
                }`}
              >
                {step}
              </span>
              {idx < trail.length - 1 && (
                <ArrowRight size={12} className="text-secondary-text/60" />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Settle Leg & Run Metadata */}
      <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-secondary-text">Settle Leg (On-Chain)</span>
          {settleUnavailable ? (
            <span className="text-sm text-secondary-text">unavailable</span>
          ) : settle ? (
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-foreground">
                  {settle.amount} {settle.assetCode}
                </span>
                <a
                  href={settle.explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                >
                  <code className="rounded bg-background px-1 py-0.5">
                    {settle.txHash.slice(0, 8)}…{settle.txHash.slice(-8)}
                  </code>
                  <ExternalLink size={12} />
                  <span className="sr-only">view on stellar.expert (opens in new tab)</span>
                </a>
              </div>
              <span className="text-xs text-secondary-text">
                Settled {new Date(settle.createdAt).toLocaleString()}
              </span>
            </div>
          ) : (
            <span className="text-sm text-secondary-text">unavailable</span>
          )}
        </div>

        <div className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-secondary-text">Nightly Workflow Run</span>
          {runUnavailable ? (
            <span className="text-sm text-secondary-text">unavailable</span>
          ) : run ? (
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span className="capitalize text-foreground font-medium">
                  {run.displayStatus}
                </span>
                <a
                  href={run.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                >
                  <span>Run #{run.id}</span>
                  <ExternalLink size={12} />
                  <span className="sr-only">view run on GitHub (opens in new tab)</span>
                </a>
              </div>
              <span className="text-xs text-secondary-text">
                Executed {new Date(run.createdAt).toLocaleString()}
              </span>
            </div>
          ) : (
            <span className="text-sm text-secondary-text">unavailable</span>
          )}
        </div>
      </div>
    </Card>
  );
}
