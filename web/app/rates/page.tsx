import type { Metadata } from "next";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import {
  fetchRateSummaries,
  latestRateSummaries,
  type RateSummary,
} from "@/lib/rate-summaries";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Daily rate summaries — corridor-in-a-box",
  description: "Published daily rate summaries for corridor pairs.",
};

export default async function RatesPage() {
  const snapshot = await fetchRateSummaries();
  const rows = latestRateSummaries(snapshot.summaries);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Daily rate summaries</h1>
        <p className="max-w-3xl text-secondary-text">
          Each row is the latest published summary for a pair and source. Every value in a row
          comes from the source and date shown in that row.
        </p>
        <div className="flex flex-wrap items-center gap-3 text-sm text-secondary-text">
          <span>Read at {snapshot.readAt}</span>
          <Link
            href="/api/rate-summaries"
            className="rounded-lg border border-border px-3 py-1 font-medium text-primary-text hover:bg-bg-subtle"
          >
            JSON endpoint
          </Link>
        </div>
      </section>

      {!snapshot.ok ? (
        <Card>
          <p className="text-sm text-secondary-text">
            {snapshot.error === "not_configured"
              ? "No rate summary source is configured. Nothing is shown rather than an assumed rate."
              : `Rate summaries could not be read (${snapshot.error}). No values are shown.`}
          </p>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <p className="text-sm text-secondary-text">No daily rate summaries have been published.</p>
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">
              Daily rate summaries. Every statistic comes from the source and date in its row.
            </caption>
            <thead>
              <tr className="text-xs uppercase tracking-wide text-secondary-text">
                <th className="py-2 pr-4 font-medium">Pair</th>
                <th className="py-2 pr-4 font-medium">Date</th>
                <th className="py-2 pr-4 font-medium">Source</th>
                <th className="py-2 pr-4 font-medium">Samples</th>
                <th className="py-2 pr-4 font-medium">Min</th>
                <th className="py-2 pr-4 font-medium">P25</th>
                <th className="py-2 pr-4 font-medium">Median</th>
                <th className="py-2 pr-4 font-medium">P75</th>
                <th className="py-2 font-medium">Max</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.pair}:${row.source}`} className="border-t border-border align-top">
                  <th scope="row" className="py-2 pr-4 font-mono text-xs font-medium">
                    {row.pair}
                  </th>
                  <td className="py-2 pr-4 font-mono text-xs">{row.date}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-secondary-text">{row.source}</td>
                  <Metric label="Samples" value={row.sampleCount} row={row} />
                  <Metric label="Min" value={row.min} row={row} />
                  <Metric label="P25" value={row.p25} row={row} />
                  <Metric label="Median" value={row.median} row={row} />
                  <Metric label="P75" value={row.p75} row={row} />
                  <Metric label="Max" value={row.max} row={row} />
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  row,
}: {
  label: string;
  value: string | number;
  row: RateSummary;
}) {
  return (
    <td
      className="py-2 pr-4 font-mono text-xs"
      aria-label={`${label} ${value} from ${row.source} on ${row.date}`}
    >
      {value}
    </td>
  );
}
