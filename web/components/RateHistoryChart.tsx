"use client";

import { useState, useId, useEffect, useRef } from "react";
import { AlertCircle, CheckCircle2, TrendingUp, Info } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import {
  type CurrencyPairRateHistory,
  buildAnchorSegments,
  segmentsToSvgPath,
} from "@/lib/rates";

interface RateHistoryChartProps {
  readonly initialData: readonly CurrencyPairRateHistory[];
  readonly preselectedPair?: string;
}

const ANCHOR_COLORS = [
  { stroke: "#2563eb", darkStroke: "#3b82f6", bg: "bg-blue-600 dark:bg-blue-500" },
  { stroke: "#059669", darkStroke: "#10b981", bg: "bg-emerald-600 dark:bg-emerald-500" },
  { stroke: "#d97706", darkStroke: "#f59e0b", bg: "bg-amber-600 dark:bg-amber-500" },
  { stroke: "#7c3aed", darkStroke: "#8b5cf6", bg: "bg-purple-600 dark:bg-purple-500" },
];

function formatRate(num: number): string {
  if (num >= 100) return num.toFixed(2);
  if (num >= 1) return num.toFixed(4);
  return num.toFixed(6);
}

export function RateHistoryChart({ initialData, preselectedPair }: RateHistoryChartProps) {
  const [data, setData] = useState<readonly CurrencyPairRateHistory[]>(initialData);
  const [selectedPair, setSelectedPair] = useState<string>(() => {
    if (preselectedPair) {
      const match = initialData.find(
        (p) =>
          p.pair === preselectedPair ||
          p.displayPair === preselectedPair ||
          p.pair.includes(preselectedPair),
      );
      if (match) return match.pair;
    }
    return initialData[0]?.pair ?? "";
  });

  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const p25GradId = useId();

  // Read from the daily summary endpoint on mount to keep data fresh
  useEffect(() => {
    let active = true;
    async function loadSummary() {
      try {
        const res = await fetch("/api/rates/daily-summary");
        if (res.ok) {
          const json = (await res.json()) as { pairs?: CurrencyPairRateHistory[] };
          if (active && Array.isArray(json.pairs) && json.pairs.length > 0) {
            setData(json.pairs);
          }
        }
      } catch {
        // Fallback to initial data gracefully
      }
    }
    void loadSummary();
    return () => {
      active = false;
    };
  }, []);

  const activePair = data.find((p) => p.pair === selectedPair) ?? data[0];

  // Chart dimensions
  const width = 760;
  const height = 300;
  const padLeft = 60;
  const padRight = 30;
  const padTop = 30;
  const padBottom = 45;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const points = activePair?.points ?? [];

  // Compute min and max values across all valid rates, reference rates, and p25
  let min = Infinity;
  let max = -Infinity;

  for (const pt of points) {
    min = Math.min(min, pt.referenceRate, pt.p25);
    max = Math.max(max, pt.referenceRate, pt.p25);
    for (const val of Object.values(pt.rates)) {
      if (val !== null && val !== undefined) {
        min = Math.min(min, val);
        max = Math.max(max, val);
      }
    }
  }

  const spread = Number.isFinite(min) && Number.isFinite(max) ? max - min || min * 0.02 || 0.02 : 0.02;
  const minVal = Number.isFinite(min) ? min - spread * 0.15 : 0.99;
  const maxVal = Number.isFinite(max) ? max + spread * 0.15 : 1.01;

  const mapX = (index: number) => {
    if (points.length <= 1) return padLeft + plotWidth / 2;
    return padLeft + (index / (points.length - 1)) * plotWidth;
  };

  const mapY = (val: number) => {
    const range = maxVal - minVal;
    if (range <= 0) return padTop + plotHeight / 2;
    return padTop + plotHeight - ((val - minVal) / range) * plotHeight;
  };

  // Y-axis grid ticks (4 evenly spaced levels)
  const yTicks = [0, 0.33, 0.66, 1].map((pct) => {
    const value = minVal + pct * (maxVal - minVal);
    const y = mapY(value);
    return { value, y };
  });

  // P25 band area polygon (between P25 line and reference rate line)
  let p25AreaPath = "";
  let p25LinePath = "";
  let referenceLinePath = "";

  if (points.length > 0) {
    let topPath = `M ${mapX(0).toFixed(2)} ${mapY(points[0].referenceRate).toFixed(2)}`;
    for (let i = 1; i < points.length; i++) {
      topPath += ` L ${mapX(i).toFixed(2)} ${mapY(points[i].referenceRate).toFixed(2)}`;
    }
    let bottomPath = "";
    for (let i = points.length - 1; i >= 0; i--) {
      bottomPath += ` L ${mapX(i).toFixed(2)} ${mapY(points[i].p25).toFixed(2)}`;
    }
    p25AreaPath = `${topPath}${bottomPath} Z`;

    p25LinePath = `M ${mapX(0).toFixed(2)} ${mapY(points[0].p25).toFixed(2)}`;
    for (let i = 1; i < points.length; i++) {
      p25LinePath += ` L ${mapX(i).toFixed(2)} ${mapY(points[i].p25).toFixed(2)}`;
    }

    referenceLinePath = `M ${mapX(0).toFixed(2)} ${mapY(points[0].referenceRate).toFixed(2)}`;
    for (let i = 1; i < points.length; i++) {
      referenceLinePath += ` L ${mapX(i).toFixed(2)} ${mapY(points[i].referenceRate).toFixed(2)}`;
    }
  }

  // Per-anchor discontinuous paths that do NOT draw through gaps
  const anchorPaths = activePair
    ? activePair.anchors.map((anchor, idx) => {
        const segments = buildAnchorSegments(points, anchor, mapX, mapY);
        const path = segmentsToSvgPath(segments);
        const color = ANCHOR_COLORS[idx % ANCHOR_COLORS.length];
        return { anchor, path, segments, color };
      })
    : [];

  // Collect gap points where any anchor has null rate
  const gapMarkers: { index: number; x: number; date: string; anchors: string[] }[] = [];
  if (activePair) {
    points.forEach((pt, idx) => {
      const missingAnchors = activePair.anchors.filter((a) => pt.rates[a] === null);
      if (missingAnchors.length > 0) {
        gapMarkers.push({
          index: idx,
          x: mapX(idx),
          date: pt.date,
          anchors: missingAnchors,
        });
      }
    });
  }

  // Pointer move handler to track hover position
  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!svgRef.current || points.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const svgX = (clientX / rect.width) * width;

    // Find nearest point
    let nearestIdx = 0;
    let nearestDist = Infinity;
    points.forEach((_, i) => {
      const px = mapX(i);
      const dist = Math.abs(svgX - px);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIdx = i;
      }
    });

    setHoverIndex(nearestIdx);
  };

  const handlePointerLeave = () => {
    setHoverIndex(null);
  };

  const hoveredPoint = hoverIndex !== null ? points[hoverIndex] : null;

  return (
    <Card className="flex flex-col gap-6">
      {/* Top Header & Pair Tabs */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-lg text-primary-text">Rate History & Price Stability</h3>
            <span className="inline-flex items-center gap-1 text-xs text-secondary-text rounded-full bg-bg-subtle px-2 py-0.5 border border-border">
              <TrendingUp size={12} className="text-blue-600 dark:text-blue-400" /> RFC 0004 Smart Router
            </span>
          </div>
          <p className="mt-1 text-sm text-secondary-text">
            Anchor quote stability determines eligibility for router estimated pricing. Gaps mark dates where no rates were collected.
          </p>
        </div>

        {/* Currency Pair Selector Tabs - phone width scrollable */}
        <div
          role="tablist"
          aria-label="Currency pair rate history"
          className="flex overflow-x-auto pb-1 gap-1.5 sm:flex-wrap sm:pb-0"
        >
          {data.map((p) => {
            const isSelected = p.pair === activePair?.pair;
            return (
              <button
                key={p.pair}
                role="tab"
                aria-selected={isSelected}
                onClick={() => {
                  setSelectedPair(p.pair);
                  setHoverIndex(null);
                }}
                className={`whitespace-nowrap px-3 py-1.5 text-xs font-medium rounded-lg transition-colors border ${
                  isSelected
                    ? "bg-blue-600 text-white border-blue-600 shadow-sm dark:bg-blue-600 dark:border-blue-500"
                    : "bg-bg-subtle text-secondary-text border-border hover:bg-border/60 hover:text-primary-text"
                }`}
              >
                {p.displayPair}
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Chart Area */}
      <div className="relative flex flex-col gap-3">
        {/* SVG Container */}
        <div className="relative w-full overflow-hidden rounded-xl border border-border bg-bg-subtle/50 p-2 sm:p-4">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${width} ${height}`}
            className="w-full h-auto touch-pan-x select-none overflow-visible"
            onPointerMove={handlePointerMove}
            onPointerLeave={handlePointerLeave}
          >
            <defs>
              <linearGradient id={p25GradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#6366f1" stopOpacity="0.22" />
                <stop offset="100%" stopColor="#6366f1" stopOpacity="0.05" />
              </linearGradient>
            </defs>

            {/* Y-axis grid lines and labels */}
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
                  className="fill-secondary-text text-[11px] font-mono"
                >
                  {formatRate(value)}
                </text>
              </g>
            ))}

            {/* Marked Gaps: visual strip and indicator where data was NOT collected */}
            {gapMarkers.map((gap) => (
              <g key={`gap-indicator-${gap.index}`}>
                {/* Vertical shaded strip marking the gap */}
                <rect
                  x={gap.x - plotWidth / (points.length * 2)}
                  y={padTop}
                  width={plotWidth / points.length}
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

            {/* P25 Estimate Band shaded polygon */}
            <path
              d={p25AreaPath}
              fill={`url(#${p25GradId})`}
              className="pointer-events-none transition-opacity"
            />

            {/* P25 estimate boundary line */}
            <path
              d={p25LinePath}
              fill="none"
              className="stroke-indigo-500/70 dark:stroke-indigo-400/80 pointer-events-none"
              strokeDasharray="3 3"
              strokeWidth="1.5"
            />

            {/* Reference Rate Line */}
            <path
              d={referenceLinePath}
              fill="none"
              className="stroke-slate-500 dark:stroke-slate-400 pointer-events-none"
              strokeDasharray="6 4"
              strokeWidth="2"
            />

            {/* Anchor Lines (Discontinuous: explicitly does NOT draw through gaps) */}
            {anchorPaths.map(({ anchor, path, segments, color }) => (
              <g key={`anchor-path-${anchor}`}>
                {/* Broken path segments */}
                <path
                  d={path}
                  fill="none"
                  stroke={color.stroke}
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="dark:hidden transition-all"
                />
                <path
                  d={path}
                  fill="none"
                  stroke={color.darkStroke}
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="hidden dark:inline transition-all"
                />

                {/* Point dots on segments */}
                {segments.flatMap((seg) =>
                  seg.points.map((pt, pIdx) => (
                    <circle
                      key={`pt-${anchor}-${pIdx}`}
                      cx={pt.x}
                      cy={pt.y}
                      r={hoverIndex !== null && points[hoverIndex]?.date === pt.date ? "4.5" : "2"}
                      fill={color.stroke}
                      className="dark:fill-white stroke-background transition-all"
                      strokeWidth="1.5"
                    />
                  )),
                )}
              </g>
            ))}

            {/* X-axis date labels */}
            {points.map((pt, i) => {
              // Show evenly spaced dates (every ~6 days and last date)
              const showDate =
                i === 0 ||
                i === Math.floor(points.length / 2) ||
                i === points.length - 1 ||
                i % 6 === 0;
              if (!showDate) return null;
              const x = mapX(i);
              return (
                <text
                  key={`xtick-${pt.date}`}
                  x={x}
                  y={height - 10}
                  textAnchor="middle"
                  className="fill-secondary-text text-[10px] font-mono"
                >
                  {pt.date.slice(5)}
                </text>
              );
            })}

            {/* Hover Crosshair */}
            {hoverIndex !== null && (
              <g className="pointer-events-none">
                <line
                  x1={mapX(hoverIndex)}
                  y1={padTop}
                  x2={mapX(hoverIndex)}
                  y2={padTop + plotHeight}
                  className="stroke-primary-text/40 dark:stroke-white/50"
                  strokeDasharray="3 3"
                  strokeWidth="1"
                />
              </g>
            )}
          </svg>
        </div>

        {/* Hover Details Card / Tooltip Info */}
        <div className="min-h-[76px] rounded-xl border border-border bg-background p-3.5 shadow-xs sm:p-4">
          {hoveredPoint ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
                <span className="font-mono text-xs font-semibold text-primary-text">
                  Date: {hoveredPoint.date}
                </span>
                <div className="flex items-center gap-4 text-xs font-mono">
                  <span className="text-secondary-text">
                    Reference:{" "}
                    <strong className="text-primary-text">{formatRate(hoveredPoint.referenceRate)}</strong>
                  </span>
                  <span className="text-indigo-600 dark:text-indigo-400">
                    P25 Band: <strong>{formatRate(hoveredPoint.p25)}</strong>
                  </span>
                </div>
              </div>

              {/* Anchor Rates on this date */}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
                {activePair.anchors.map((anchor, aIdx) => {
                  const rate = hoveredPoint.rates[anchor];
                  const color = ANCHOR_COLORS[aIdx % ANCHOR_COLORS.length];
                  const isGap = rate === null || rate === undefined;

                  return (
                    <div
                      key={`hover-anchor-${anchor}`}
                      className="flex items-center justify-between gap-2 rounded-lg bg-bg-subtle px-2.5 py-1.5 text-xs"
                    >
                      <div className="flex items-center gap-1.5 truncate">
                        <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${color.bg}`} />
                        <span className="font-mono truncate text-secondary-text">{anchor}</span>
                      </div>
                      {isGap ? (
                        <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                          <AlertCircle size={10} /> No data (gap)
                        </span>
                      ) : (
                        <span className="font-mono font-semibold text-primary-text">
                          {formatRate(rate)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 text-xs text-secondary-text">
              <div className="flex items-center gap-1.5">
                <Info size={14} className="text-blue-600 dark:text-blue-400" />
                <span>Hover or touch the chart to inspect daily rates, reference rates, and missing data gaps.</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-primary-text">Latest Ref:</span>
                <span className="font-mono">{formatRate(activePair.referenceRate)}</span>
              </div>
            </div>
          )}
        </div>

        {/* Legend & Summary Info */}
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-bg-subtle/40 p-3 sm:flex-row sm:items-center sm:justify-between">
          {/* Legend Items */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-secondary-text">
            {/* Reference rate */}
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-4 border-b-2 border-dashed border-slate-500 dark:border-slate-400" />
              <span>Reference rate</span>
            </div>

            {/* P25 band */}
            <div className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-4 rounded-xs border border-indigo-400 bg-indigo-500/20" />
              <span>P25 Estimate Band</span>
            </div>

            {/* Anchors */}
            {activePair.anchors.map((anchor, idx) => {
              const color = ANCHOR_COLORS[idx % ANCHOR_COLORS.length];
              return (
                <div key={`legend-${anchor}`} className="flex items-center gap-1.5">
                  <span className={`inline-block h-2.5 w-2.5 rounded-full ${color.bg}`} />
                  <span className="font-mono">{anchor}</span>
                </div>
              );
            })}

            {/* Marked gap note */}
            <div className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
              <span className="inline-block h-3 w-2.5 rounded-xs border border-dashed border-amber-500 bg-amber-500/20" />
              <span>Marked gap (no data)</span>
            </div>
          </div>

          {/* Router Estimate Eligibility Badge */}
          <div className="flex items-center gap-2">
            <Badge variant="success">
              <CheckCircle2 size={12} />
              <span>Estimated label: Eligible</span>
            </Badge>
          </div>
        </div>
      </div>
    </Card>
  );
}
