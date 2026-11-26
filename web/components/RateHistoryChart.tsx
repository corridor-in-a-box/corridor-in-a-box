"use client";

import { useState, useId, useRef } from "react";
import { AlertCircle, CheckCircle2, Info, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import type { RateSummaryError } from "@/lib/rate-summaries";
import {
  type PairRateHistory,
  type RateHistorySeries,
  MIN_ESTIMATE_DAYS,
  MIN_ESTIMATE_SAMPLES,
  bandSegmentsToSvgPath,
  buildSeriesSegments,
  segmentsToSvgPath,
} from "@/lib/rates";

/** What the server read from the daily summary source, without the rows themselves. */
export interface RateHistorySourceStatus {
  readonly ok: boolean;
  readonly configured: boolean;
  readonly error?: RateSummaryError;
}

interface RateHistoryChartProps {
  readonly histories: readonly PairRateHistory[];
  readonly status: RateHistorySourceStatus;
  /** On a corridor page: the one pair shown, named in the empty state when it has no data. */
  readonly pairLabel?: string;
}

const SERIES_COLORS = [
  { stroke: "#2563eb", darkStroke: "#3b82f6", bg: "bg-blue-600 dark:bg-blue-500" },
  { stroke: "#059669", darkStroke: "#10b981", bg: "bg-emerald-600 dark:bg-emerald-500" },
  { stroke: "#d97706", darkStroke: "#f59e0b", bg: "bg-amber-600 dark:bg-amber-500" },
  { stroke: "#7c3aed", darkStroke: "#8b5cf6", bg: "bg-purple-600 dark:bg-purple-500" },
];

/** Formats an axis tick. Data labels show the published string, never a reformatted number. */
function formatTick(num: number): string {
  if (num >= 100) return num.toFixed(2);
  if (num >= 1) return num.toFixed(4);
  return num.toFixed(6);
}

const formatCount = (n: number) => n.toLocaleString("en-US");

export function RateHistoryChart({ histories, status, pairLabel }: RateHistoryChartProps) {
  if (!status.ok || histories.length === 0) {
    return (
      <Card className="flex flex-col gap-3">
        <ChartHeading />
        <div className="rounded-xl border border-dashed border-border bg-bg-subtle p-5 text-sm text-secondary-text">
          <div className="mb-1 font-medium text-primary-text">{emptyTitle(status, pairLabel)}</div>
          {emptyBody(status)}
        </div>
      </Card>
    );
  }
  return <LoadedChart histories={histories} />;
}

function emptyTitle(status: RateHistorySourceStatus, pairLabel?: string): string {
  if (!status.configured) return "No rate summary source configured";
  if (!status.ok) return "Rate summaries could not be read";
  return pairLabel
    ? `No rate history published for ${pairLabel} yet`
    : "No rate history published yet";
}

function emptyBody(status: RateHistorySourceStatus): string {
  if (!status.configured) {
    return "Set RATE_SUMMARIES_URL to the published daily summary JSON to chart it. No rates are shown rather than assumed ones.";
  }
  if (!status.ok) {
    return `The daily summary source did not answer with valid data (${status.error ?? "unknown error"}). No rates are shown rather than stale or assumed ones.`;
  }
  return "The chart fills in once the collector publishes daily summaries with samples for this pair. Nothing is drawn until then.";
}

function ChartHeading() {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold text-primary-text">Rate history and price stability</h3>
        <span className="inline-flex items-center gap-1 rounded-full border border-border bg-bg-subtle px-2 py-0.5 text-xs text-secondary-text">
          <TrendingUp size={12} className="text-blue-600 dark:text-blue-400" /> daily summary
        </span>
      </div>
      <p className="mt-1 max-w-2xl text-sm text-secondary-text">
        Daily median per source, with the shaded band down to the daily P25 the router&apos;s
        estimated price starts from. Gaps mark days with no published samples.
      </p>
    </div>
  );
}

function LoadedChart({ histories }: { histories: readonly PairRateHistory[] }) {
  const [selectedPair, setSelectedPair] = useState<string>(histories[0].pair);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const bandId = useId();
  const titleId = useId();

  const active = histories.find((h) => h.pair === selectedPair) ?? histories[0];
  const { dates, series } = active;

  // Chart dimensions
  const width = 760;
  const height = 300;
  const padLeft = 60;
  const padRight = 30;
  const padTop = 30;
  const padBottom = 45;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  // Value range across every published P25 and median shown.
  let min = Infinity;
  let max = -Infinity;
  for (const s of series) {
    for (const p of s.points) {
      if (!p) continue;
      for (const v of [Number(p.p25), Number(p.median)]) {
        if (Number.isFinite(v)) {
          min = Math.min(min, v);
          max = Math.max(max, v);
        }
      }
    }
  }
  const spread = max - min || Math.abs(min) * 0.02 || 0.02;
  const minVal = min - spread * 0.15;
  const maxVal = max + spread * 0.15;

  const mapX = (index: number) =>
    dates.length <= 1 ? padLeft + plotWidth / 2 : padLeft + (index / (dates.length - 1)) * plotWidth;
  const mapY = (val: number) => padTop + plotHeight - ((val - minVal) / (maxVal - minVal)) * plotHeight;

  const yTicks = [0, 0.33, 0.66, 1].map((pct) => {
    const value = minVal + pct * (maxVal - minVal);
    return { value, y: mapY(value) };
  });

  const anchors = series.filter((s) => s.kind === "anchor");
  const references = series.filter((s) => s.kind === "reference");
  const colorOf = (s: RateHistorySeries) =>
    SERIES_COLORS[Math.max(0, anchors.indexOf(s)) % SERIES_COLORS.length];

  const drawn = series.map((s) => {
    const segments = buildSeriesSegments(dates, s.points, (p) => p.median, mapX, mapY);
    return {
      series: s,
      segments,
      median: segmentsToSvgPath(segments),
      p25:
        s.kind === "anchor"
          ? segmentsToSvgPath(buildSeriesSegments(dates, s.points, (p) => p.p25, mapX, mapY))
          : "",
      band: s.kind === "anchor" ? bandSegmentsToSvgPath(dates, s.points, mapX, mapY) : "",
    };
  });

  // Days where at least one source has no published samples.
  const gapMarkers = dates
    .map((date, index) => ({
      index,
      date,
      x: mapX(index),
      missing: series.filter((s) => s.points[index] === null).map((s) => s.source),
    }))
    .filter((g) => g.missing.length > 0);

  const eligibleCount = anchors.filter((s) => s.minimumData?.meetsRule).length;

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!svgRef.current || dates.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * width;
    let nearest = 0;
    let nearestDist = Infinity;
    dates.forEach((_, i) => {
      const dist = Math.abs(svgX - mapX(i));
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = i;
      }
    });
    setHoverIndex(nearest);
  };

  const hoveredDate = hoverIndex !== null ? dates[hoverIndex] : null;

  return (
    <Card className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <ChartHeading />

        {/* Pair tabs, scrollable at phone width */}
        <div
          role="tablist"
          aria-label="Currency pair rate history"
          className="flex gap-1.5 overflow-x-auto pb-1 sm:flex-wrap sm:pb-0"
        >
          {histories.map((h) => {
            const isSelected = h.pair === active.pair;
            return (
              <button
                key={h.pair}
                type="button"
                role="tab"
                aria-selected={isSelected}
                onClick={() => {
                  setSelectedPair(h.pair);
                  setHoverIndex(null);
                }}
                className={`whitespace-nowrap rounded-lg border px-3 py-1.5 font-mono text-xs font-medium transition-colors ${
                  isSelected
                    ? "border-blue-600 bg-blue-600 text-white shadow-sm dark:border-blue-500 dark:bg-blue-600"
                    : "border-border bg-bg-subtle text-secondary-text hover:bg-border/60 hover:text-primary-text"
                }`}
              >
                {h.pair}
              </button>
            );
          })}
        </div>
      </div>

      <div className="relative flex flex-col gap-3">
        <div className="relative w-full overflow-hidden rounded-xl border border-border bg-bg-subtle/50 p-2 sm:p-4">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${width} ${height}`}
            aria-labelledby={titleId}
            className="h-auto w-full touch-pan-x select-none overflow-visible"
            onPointerMove={handlePointerMove}
            onPointerLeave={() => setHoverIndex(null)}
          >
            <title id={titleId}>
              {`Daily median and P25 per source for ${active.pair}, ${dates[0]} to ${dates[dates.length - 1]}`}
            </title>
            <defs>
              <linearGradient id={bandId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#6366f1" stopOpacity="0.22" />
                <stop offset="100%" stopColor="#6366f1" stopOpacity="0.08" />
              </linearGradient>
            </defs>

            {yTicks.map(({ value, y }, i) => (
              <g key={`ytick-${i}`}>
                <line
                  x1={padLeft}
                  y1={y}
                  x2={width - padRight}
                  y2={y}
                  className="stroke-border/70 dark:stroke-border/50"
                  strokeDasharray="4 4"
                  strokeWidth="1"
                />
                <text
                  x={padLeft - 8}
                  y={y + 4}
                  textAnchor="end"
                  className="fill-secondary-text font-mono text-[11px]"
                >
                  {formatTick(value)}
                </text>
              </g>
            ))}

            {/* Days with no published samples for at least one source */}
            {gapMarkers.map((gap) => (
              <g key={`gap-${gap.index}`}>
                <rect
                  x={gap.x - plotWidth / (dates.length * 2)}
                  y={padTop}
                  width={plotWidth / dates.length}
                  height={plotHeight}
                  className="fill-amber-500/10 dark:fill-amber-400/10"
                />
                <line
                  x1={gap.x}
                  y1={padTop}
                  x2={gap.x}
                  y2={padTop + plotHeight}
                  className="stroke-amber-500/50 dark:stroke-amber-400/50"
                  strokeDasharray="2 3"
                  strokeWidth="1"
                />
              </g>
            ))}

            {/* P25-to-median bands, broken at gaps */}
            {drawn.map(({ series: s, band }) =>
              band ? (
                <path
                  key={`band-${s.source}`}
                  d={band}
                  fill={`url(#${bandId})`}
                  className="pointer-events-none"
                />
              ) : null,
            )}

            {/* P25 edges */}
            {drawn.map(({ series: s, p25 }) =>
              p25 ? (
                <path
                  key={`p25-${s.source}`}
                  d={p25}
                  fill="none"
                  className="pointer-events-none stroke-indigo-500/70 dark:stroke-indigo-400/80"
                  strokeDasharray="3 3"
                  strokeWidth="1.5"
                />
              ) : null,
            )}

            {/* Reference FX median, when published */}
            {drawn
              .filter(({ series: s }) => s.kind === "reference")
              .map(({ series: s, median }) => (
                <path
                  key={`ref-${s.source}`}
                  d={median}
                  fill="none"
                  className="pointer-events-none stroke-slate-500 dark:stroke-slate-400"
                  strokeDasharray="6 4"
                  strokeWidth="2"
                />
              ))}

            {/* One median line per anchor source, never drawn across a gap */}
            {drawn
              .filter(({ series: s }) => s.kind === "anchor")
              .map(({ series: s, median, segments }) => {
                const color = colorOf(s);
                return (
                  <g key={`line-${s.source}`}>
                    <path
                      d={median}
                      fill="none"
                      stroke={color.stroke}
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="dark:hidden"
                    />
                    <path
                      d={median}
                      fill="none"
                      stroke={color.darkStroke}
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="hidden dark:inline"
                    />
                    {segments.flatMap((seg) =>
                      seg.points.map((pt) => (
                        <circle
                          key={`pt-${s.source}-${pt.date}`}
                          cx={pt.x}
                          cy={pt.y}
                          r={hoveredDate === pt.date ? "4.5" : "2"}
                          fill={color.stroke}
                          className="stroke-background dark:fill-white"
                          strokeWidth="1.5"
                        />
                      )),
                    )}
                  </g>
                );
              })}

            {dates.map((date, i) => {
              const show =
                i === 0 || i === Math.floor(dates.length / 2) || i === dates.length - 1 || i % 6 === 0;
              if (!show) return null;
              return (
                <text
                  key={`xtick-${date}`}
                  x={mapX(i)}
                  y={height - 10}
                  textAnchor="middle"
                  className="fill-secondary-text font-mono text-[10px]"
                >
                  {date.slice(5)}
                </text>
              );
            })}

            {hoverIndex !== null && (
              <line
                x1={mapX(hoverIndex)}
                y1={padTop}
                x2={mapX(hoverIndex)}
                y2={padTop + plotHeight}
                className="pointer-events-none stroke-primary-text/40 dark:stroke-white/50"
                strokeDasharray="3 3"
                strokeWidth="1"
              />
            )}
          </svg>
        </div>

        {/* Hover details: the published values for the day, as published */}
        <div className="min-h-[76px] rounded-xl border border-border bg-background p-3.5 shadow-xs sm:p-4">
          {hoverIndex !== null && hoveredDate ? (
            <div className="flex flex-col gap-2">
              <span className="border-b border-border pb-2 font-mono text-xs font-semibold text-primary-text">
                {hoveredDate}
              </span>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
                {series.map((s) => {
                  const p = s.points[hoverIndex];
                  const swatch =
                    s.kind === "reference" ? "bg-slate-500 dark:bg-slate-400" : colorOf(s).bg;
                  return (
                    <div
                      key={`hover-${s.source}`}
                      className="flex items-center justify-between gap-2 rounded-lg bg-bg-subtle px-2.5 py-1.5 text-xs"
                    >
                      <div className="flex items-center gap-1.5 truncate">
                        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${swatch}`} />
                        <span className="truncate font-mono text-secondary-text">{s.source}</span>
                      </div>
                      {p ? (
                        <span className="text-right font-mono tabular-nums text-primary-text">
                          <strong>{p.median}</strong>
                          <span className="text-indigo-600 dark:text-indigo-400"> P25 {p.p25}</span>
                          <span className="text-secondary-text"> · {formatCount(p.sampleCount)}</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                          <AlertCircle size={10} /> no data
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-secondary-text">
              <Info size={14} className="shrink-0 text-blue-600 dark:text-blue-400" />
              <span>
                Hover or touch the chart for each source&apos;s median, P25 and sample count that
                day. {dates[0]} to {dates[dates.length - 1]}.
              </span>
            </div>
          )}
        </div>

        {/* Legend and the RFC 0004 minimum-data rule, from the published counts */}
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-bg-subtle/40 p-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-secondary-text">
            {references.length > 0 ? (
              <div className="flex items-center gap-1.5">
                <span className="inline-block w-4 border-b-2 border-dashed border-slate-500 dark:border-slate-400" />
                <span>Reference FX ({references.map((r) => r.source).join(", ")})</span>
              </div>
            ) : (
              <span>No reference FX rate published for this pair</span>
            )}
            <div className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-4 rounded-xs border border-indigo-400 bg-indigo-500/20" />
              <span>P25 to median</span>
            </div>
            <div className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
              <span className="inline-block h-3 w-2.5 rounded-xs border border-dashed border-amber-500 bg-amber-500/20" />
              <span>Gap (no samples)</span>
            </div>
          </div>

          {anchors.length > 0 && (
            <ul className="flex flex-col gap-1.5 text-xs">
              {anchors.map((s) => {
                const m = s.minimumData;
                return (
                  <li key={`legend-${s.source}`} className="flex flex-wrap items-center gap-2">
                    <span className={`inline-block h-2.5 w-2.5 rounded-full ${colorOf(s).bg}`} />
                    <span className="font-mono text-primary-text">{s.source}</span>
                    {m && (
                      <>
                        <Badge variant={m.meetsRule ? "success" : "default"}>
                          {m.meetsRule ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
                          {m.meetsRule ? "meets minimum data" : "below minimum data"}
                        </Badge>
                        <span className="font-mono tabular-nums text-secondary-text">
                          {m.daysWithData} d · {formatCount(m.samplesInWindow)} samples{" "}
                          {m.windowStart} to {m.windowEnd}
                        </span>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {anchors.length > 0 && (
            <p className="text-xs text-secondary-text">
              {eligibleCount} of {anchors.length} source{anchors.length === 1 ? "" : "s"} meet the
              RFC 0004 minimum for an estimated price: at least {MIN_ESTIMATE_DAYS} days of data
              and {MIN_ESTIMATE_SAMPLES} samples in the last 7 days, counted from these daily
              summaries. The router decides on the raw samples.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
