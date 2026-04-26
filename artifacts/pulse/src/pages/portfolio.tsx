import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Link } from "wouter";
import {
  useGetPortfolioSummary,
  useGetPortfolioDistribution,
  getGetPortfolioDistributionQueryKey,
  useGetPortfolioDistributionHistory,
  useGetMe,
  PortfolioSizeBand,
  type PortfolioStallReason,
  type PortfolioEngagement,
  type PortfolioDistribution,
  type PortfolioDistributionHistory,
} from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Download, AlertTriangle } from "lucide-react";
import { formatRelative } from "@/lib/format";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
} from "recharts";

const ALL = "__all__";

// How many engagements to list inside each Stage column on the snapshot
// bar before collapsing the rest into a single "and N more" footer.
const STAGE_COLUMN_TOP_N = 10;

const STALL_LABEL: Record<PortfolioStallReason, string> = {
  low_survey_response: "Low survey response",
  stale_connectors: "Stale connectors",
  no_finalized_deliverable: "No finalized deliverable",
};

const SIZE_LABEL: Record<string, string> = {
  small: "Small (≤5)",
  medium: "Medium (6–25)",
  large: "Large (>25)",
};

// Each maturity stage gets a fixed identity hue so the column colours, the
// stacked-area trend, and the engagement badges all read as the same stage.
// Stage 1 = dim red (legacy/risk), 5 = strong green (dark factory).
const STAGE_HUE: Record<number, number> = {
  1: 12, // legacy — warm red
  2: 32, // amber
  3: 48, // gold
  4: 152, // teal
  5: 168, // strong green-teal
};

function stageColor(stage: number, alpha = 1): string {
  const hue = STAGE_HUE[stage] ?? 220;
  return `hsla(${hue}, 70%, 48%, ${alpha})`;
}

function stageColumnStyle(stage: number, percent: number): CSSProperties {
  // Tinted column whose interior is filled from the bottom proportional to
  // the percentage. We use a CSS gradient so the fill sits behind text and
  // links without requiring a second positioned element.
  const fillHeight = Math.round(percent * 100);
  const fillTop = 100 - fillHeight;
  return {
    background: `linear-gradient(to top,
      ${stageColor(stage, 0.85)} 0%,
      ${stageColor(stage, 0.85)} ${fillHeight}%,
      ${stageColor(stage, 0.06)} ${fillHeight}%,
      ${stageColor(stage, 0.06)} 100%)`,
    borderColor: stageColor(stage, 0.35),
    // Hint to the browser: the gradient stop is below `fillTop` from the top.
    // Used purely for screen-reader/test-id intuition; visual layout is the
    // gradient.
    ["--stage-fill-top" as never]: `${fillTop}%`,
  };
}

export default function PortfolioPage() {
  const [industry, setIndustry] = useState<string>(ALL);
  const [size, setSize] = useState<string>(ALL);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);

  const filterParams = useMemo(() => {
    const p: Record<string, string> = {};
    if (industry !== ALL) p.industry = industry;
    if (size !== ALL) p.size = size;
    return p;
  }, [industry, size]);

  // Summary feeds the engagements table + stalled widget + industry list.
  const { data: summary, isLoading: loadingSummary } =
    useGetPortfolioSummary(filterParams);

  // History strip is anchored on the current month at page load. When the
  // user drags the playhead we only re-fetch the snapshot, not the history.
  const { data: history, isLoading: loadingHistory } =
    useGetPortfolioDistributionHistory(filterParams);
  const months = history?.months ?? [];
  const lastMonth = months.length > 0 ? months[months.length - 1].month : null;
  const effectiveMonth = selectedMonth ?? lastMonth;

  // `placeholderData: keepPreviousData` keeps the previous month's
  // distribution rendered while the next one is fetching, so dragging the
  // playhead updates the snapshot's content in place rather than flashing
  // a skeleton on every step.
  const distributionParams = effectiveMonth
    ? { ...filterParams, month: effectiveMonth }
    : filterParams;
  const { data: distribution, isLoading: loadingDistribution } =
    useGetPortfolioDistribution(distributionParams, {
      query: {
        queryKey: getGetPortfolioDistributionQueryKey(distributionParams),
        placeholderData: (prev) => prev,
      },
    });

  const { data: me } = useGetMe();
  const isAdmin = me?.role === "admin";

  const benchmarkQuery = new URLSearchParams(filterParams).toString();
  const benchmarkUrl =
    `${import.meta.env.BASE_URL}api/portfolio/benchmark.csv` +
    (benchmarkQuery ? `?${benchmarkQuery}` : "");

  const engagements = summary?.engagements ?? [];
  const stalled = engagements.filter((e) => e.stallReasons.length > 0);

  // Reset the playhead when the filters change so we don't keep an out-of-
  // range month selected for an empty filter set.
  useEffect(() => {
    setSelectedMonth(null);
  }, [industry, size]);

  return (
    <AppLayout>
      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Portfolio</h1>
        <p className="text-muted-foreground mt-1">
          Where our clients sit on the maturity curve, and how that's moved
          month over month.
        </p>
      </div>

      {/* Filters */}
      <Card className="mb-6">
        <CardContent className="flex flex-wrap items-end gap-4 pt-6">
          <div className="min-w-[200px] flex-1">
            <label className="block text-xs font-medium mb-1 text-muted-foreground">
              Industry
            </label>
            <Select value={industry} onValueChange={setIndustry}>
              <SelectTrigger data-testid="select-industry">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All industries</SelectItem>
                {(summary?.industries ?? []).map((i) => (
                  <SelectItem key={i} value={i}>
                    {i}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-[200px] flex-1">
            <label className="block text-xs font-medium mb-1 text-muted-foreground">
              Engineering Org size
            </label>
            <Select value={size} onValueChange={setSize}>
              <SelectTrigger data-testid="select-size">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All sizes</SelectItem>
                {Object.values(PortfolioSizeBand).map((b) => (
                  <SelectItem key={b} value={b}>
                    {SIZE_LABEL[b]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {(industry !== ALL || size !== ALL) && (
            <Button
              variant="ghost"
              onClick={() => {
                setIndustry(ALL);
                setSize(ALL);
              }}
              data-testid="button-clear-filters"
            >
              Clear
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Snapshot + history card (single connected card with no inter-card gap) */}
      <Card className="mb-6 overflow-hidden">
        <CardContent className="p-0">
          <SnapshotBar
            distribution={distribution ?? null}
            loading={loadingDistribution}
          />
          <HistoryStrip
            history={history ?? null}
            loading={loadingHistory}
            selectedMonth={effectiveMonth}
            onSelectMonth={setSelectedMonth}
          />
        </CardContent>
      </Card>

      {/* Operational signals: stalled engagements + admin-only benchmark CSV */}
      {(stalled.length > 0 || isAdmin) && (
        <div className="mb-6 grid gap-4 lg:grid-cols-3">
          {stalled.length > 0 && (
            <Card
              className={`border-amber-500/40 ${isAdmin ? "lg:col-span-2" : "lg:col-span-3"}`}
            >
              <CardContent className="pt-6">
                <div className="flex items-center gap-2 mb-3">
                  <AlertTriangle className="h-5 w-5 text-amber-500" />
                  <h2 className="text-lg font-semibold">Stalled engagements</h2>
                </div>
                <ul className="divide-y">
                  {stalled.map((e) => (
                    <li
                      key={e.id}
                      className="py-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"
                      data-testid={`stalled-${e.id}`}
                    >
                      <Link
                        href={`/engagements/${e.id}`}
                        className="font-medium hover:text-primary"
                      >
                        {e.clientName}
                      </Link>
                      <div className="flex flex-wrap gap-1.5 sm:justify-end">
                        {e.stallReasons.map((r) => (
                          <StallBadge key={r} engagement={e} reason={r} />
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
          {isAdmin && (
            <Card className={stalled.length > 0 ? "" : "lg:col-span-3"}>
              <CardContent className="pt-6 flex flex-col gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Benchmark export</h2>
                  <p className="text-sm text-muted-foreground mt-1">
                    Anonymized cross-engagement averages by industry, size, and
                    dimension.
                  </p>
                </div>
                <a href={benchmarkUrl} target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" data-testid="button-export-benchmark">
                    <Download className="mr-2 h-4 w-4" />
                    Benchmark CSV
                  </Button>
                </a>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Engagements table */}
      <EngagementsTable
        engagements={engagements}
        loading={loadingSummary}
      />
    </AppLayout>
  );
}

function SnapshotBar({
  distribution,
  loading,
}: {
  distribution: PortfolioDistribution | null;
  loading: boolean;
}) {
  if (loading || !distribution) {
    return <Skeleton className="h-[420px] w-full rounded-none" />;
  }
  const bins = distribution.byStage;
  const total = distribution.total;
  return (
    <div
      className="px-6 pt-6 pb-2"
      data-testid="snapshot-bar"
      data-month={distribution.month}
    >
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-lg font-semibold">Where our clients are</h2>
        <div className="text-sm text-muted-foreground">
          <span className="font-mono" data-testid="snapshot-month">
            {formatMonthLabel(distribution.month)}
          </span>
          <span className="mx-2">·</span>
          <span data-testid="snapshot-total">
            {total} engagement{total === 1 ? "" : "s"}
          </span>
          {distribution.notYetAssessed.length > 0 && (
            <>
              <span className="mx-2">·</span>
              <span className="text-muted-foreground/80" data-testid="snapshot-not-assessed">
                {distribution.notYetAssessed.length} not yet assessed
              </span>
            </>
          )}
        </div>
      </div>
      <div className="grid grid-cols-5 gap-2 h-[360px]">
        {bins.map((bin) => (
          <div
            key={bin.stage}
            className="relative rounded-lg border flex flex-col overflow-hidden"
            style={stageColumnStyle(bin.stage, bin.percent)}
            data-testid={`stage-column-${bin.stage}`}
          >
            <div className="px-3 pt-3 pb-2 relative z-10">
              <div className="text-[11px] uppercase tracking-wide font-semibold text-foreground/70">
                Stage {bin.stage}
              </div>
              <div className="text-sm font-semibold leading-tight">
                {bin.label}
              </div>
              <div className="mt-2 flex items-baseline gap-1.5">
                <span
                  className="text-2xl font-bold font-mono"
                  data-testid={`stage-percent-${bin.stage}`}
                >
                  {formatStagePercent(bin.percent)}
                </span>
                <span
                  className="text-xs text-foreground/70"
                  data-testid={`stage-count-${bin.stage}`}
                >
                  ({bin.count})
                </span>
              </div>
            </div>
            <div className="flex-1 px-3 pb-3 pt-1 relative z-10 overflow-y-auto">
              <ul className="space-y-1">
                {bin.engagements
                  .slice(0, STAGE_COLUMN_TOP_N)
                  .map((e) => (
                    <li key={e.id}>
                      <Link
                        href={`/engagements/${e.id}`}
                        className="block text-xs leading-tight font-medium text-foreground hover:underline truncate"
                        data-testid={`stage-engagement-${e.id}`}
                        title={`${e.clientName} · ${e.teamCount} on team`}
                      >
                        {e.clientName}
                      </Link>
                    </li>
                  ))}
                {bin.engagements.length > STAGE_COLUMN_TOP_N && (
                  <li
                    className="text-[11px] text-foreground/60 italic pt-0.5"
                    data-testid={`stage-more-${bin.stage}`}
                  >
                    and {bin.engagements.length - STAGE_COLUMN_TOP_N} more
                  </li>
                )}
                {bin.engagements.length === 0 && (
                  <li className="text-[11px] text-foreground/50 italic">
                    None
                  </li>
                )}
              </ul>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface HistoryStripProps {
  history: PortfolioDistributionHistory | null;
  loading: boolean;
  selectedMonth: string | null;
  onSelectMonth: (m: string) => void;
}

function HistoryStrip({
  history,
  loading,
  selectedMonth,
  onSelectMonth,
}: HistoryStripProps) {
  // Strip is ~20% of the snapshot height (snapshot ~360px → strip ~72px).
  const STRIP_HEIGHT = 72;
  const containerRef = useRef<HTMLDivElement | null>(null);

  const months = history?.months ?? [];
  // Recharts wants flat-rows: one object per month with one numeric field
  // per stage. Percent is on a 0-1 scale already.
  const data = useMemo(
    () =>
      months.map((m) => {
        const pct: Record<string, number> = {};
        for (const s of m.byStage) pct[`s${s.stage}`] = s.percent;
        return { month: m.month, total: m.total, ...pct };
      }),
    [months],
  );

  const selectedIndex = useMemo(() => {
    if (!selectedMonth) return Math.max(0, months.length - 1);
    const idx = months.findIndex((m) => m.month === selectedMonth);
    return idx === -1 ? Math.max(0, months.length - 1) : idx;
  }, [months, selectedMonth]);

  const handleSelectByIndex = useCallback(
    (idx: number) => {
      const clamped = Math.max(0, Math.min(months.length - 1, idx));
      const m = months[clamped];
      if (m) onSelectMonth(m.month);
    },
    [months, onSelectMonth],
  );

  const handleSelectFromX = useCallback(
    (clientX: number) => {
      const el = containerRef.current;
      if (!el || months.length === 0) return;
      const rect = el.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const ratio = rect.width === 0 ? 0 : x / rect.width;
      handleSelectByIndex(Math.round(ratio * (months.length - 1)));
    },
    [handleSelectByIndex, months.length],
  );

  // Drag tracking on the strip surface itself.
  const draggingRef = useRef(false);
  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!draggingRef.current) return;
      handleSelectFromX(e.clientX);
    }
    function onUp() {
      draggingRef.current = false;
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [handleSelectFromX]);

  if (loading) {
    return (
      <div className="border-t bg-muted/20 px-6 pt-3 pb-4">
        <Skeleton className="h-[72px] w-full" />
      </div>
    );
  }
  if (months.length === 0) {
    return (
      <div className="border-t bg-muted/20 px-6 py-6 text-sm text-muted-foreground">
        No history yet — score an engagement to start the trend.
      </div>
    );
  }

  // Position of the playhead as a percentage along the strip.
  const playheadPct =
    months.length <= 1 ? 100 : (selectedIndex / (months.length - 1)) * 100;

  return (
    <div className="border-t bg-muted/20 pt-3 pb-3" data-testid="history-strip">
      <div
        ref={containerRef}
        className="relative mx-6 cursor-ew-resize select-none"
        style={{ height: STRIP_HEIGHT }}
        onMouseDown={(e) => {
          draggingRef.current = true;
          handleSelectFromX(e.clientX);
        }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={data}
            margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
          >
            <XAxis dataKey="month" hide />
            {[1, 2, 3, 4, 5].map((stage) => (
              <Area
                key={stage}
                type="monotone"
                dataKey={`s${stage}`}
                stackId="dist"
                stroke={stageColor(stage, 0.9)}
                fill={stageColor(stage, 0.7)}
                fillOpacity={1}
                isAnimationActive={false}
              />
            ))}
            <Tooltip content={<HistoryTooltip />} />
          </AreaChart>
        </ResponsiveContainer>
        {/* Playhead — visually marks the selected month and also blocks the
            chart's tooltip while dragging via pointerEvents:none. */}
        <div
          className="absolute top-0 bottom-0 pointer-events-none"
          style={{ left: `${playheadPct}%`, transform: "translateX(-1px)" }}
          data-testid="history-playhead"
        >
          <div className="w-[2px] h-full bg-foreground/80 shadow" />
          <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-foreground border-2 border-background shadow" />
        </div>
      </div>
      <div className="mx-6 mt-2 flex justify-end">
        <div className="text-xs font-mono text-muted-foreground">
          {formatMonthLabel(months[selectedIndex]?.month ?? "")}
        </div>
      </div>
    </div>
  );
}

interface RechartsTooltipPayloadEntry {
  dataKey: string;
  value: number;
  payload: { month: string; total: number };
}

function HistoryTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: RechartsTooltipPayloadEntry[];
}) {
  if (!active || !payload || payload.length === 0) return null;
  const month = payload[0].payload.month;
  const total = payload[0].payload.total;
  return (
    <div className="rounded-md border bg-background px-3 py-2 text-xs shadow-md">
      <div className="font-semibold mb-1">{formatMonthLabel(month)}</div>
      <div className="text-muted-foreground">
        {total} engagement{total === 1 ? "" : "s"}
      </div>
      <div className="mt-1 space-y-0.5">
        {[5, 4, 3, 2, 1].map((stage) => {
          const entry = payload.find((p) => p.dataKey === `s${stage}`);
          const pct = entry ? Math.round(entry.value * 100) : 0;
          if (pct === 0) return null;
          return (
            <div key={stage} className="flex items-center gap-1.5">
              <span
                className="inline-block w-2 h-2 rounded-sm"
                style={{ backgroundColor: stageColor(stage, 0.85) }}
              />
              <span>
                Stage {stage}: <span className="font-mono">{pct}%</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EngagementsTable({
  engagements,
  loading,
}: {
  engagements: PortfolioEngagement[];
  loading: boolean;
}) {
  type SortKey =
    | "client"
    | "industry"
    | "lead"
    | "stage"
    | "lastActivity"
    | "status";
  const [sortKey, setSortKey] = useState<SortKey>("client");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const sorted = useMemo(() => {
    const arr = [...engagements];
    arr.sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      switch (sortKey) {
        case "client":
          return a.clientName.localeCompare(b.clientName) * dir;
        case "industry":
          return (a.industry ?? "").localeCompare(b.industry ?? "") * dir;
        case "lead":
          return (a.sponsor ?? "").localeCompare(b.sponsor ?? "") * dir;
        case "status":
          return a.status.localeCompare(b.status) * dir;
        case "stage": {
          const av = a.overallStage ?? -1;
          const bv = b.overallStage ?? -1;
          return (av - bv) * dir;
        }
        case "lastActivity": {
          const at = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
          const bt = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
          return (at - bt) * dir;
        }
      }
    });
    return arr;
  }, [engagements, sortKey, sortDir]);

  const onSort = (k: SortKey) => {
    if (k === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(k);
      setSortDir(k === "stage" || k === "lastActivity" ? "desc" : "asc");
    }
  };

  return (
    <Card>
      <CardContent className="p-0">
        <div className="px-6 pt-5 pb-2">
          <h2 className="text-lg font-semibold">Engagements</h2>
          <p className="text-xs text-muted-foreground">
            Every engagement you have access to. Not-yet-assessed engagements
            still appear here so you can pick one to score.
          </p>
        </div>
        {loading ? (
          <div className="p-6 space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : sorted.length === 0 ? (
          <div className="p-10 text-center text-muted-foreground">
            No engagements match the current filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <SortableTh
                    onClick={() => onSort("client")}
                    active={sortKey === "client"}
                    dir={sortDir}
                  >
                    Client
                  </SortableTh>
                  <SortableTh
                    onClick={() => onSort("industry")}
                    active={sortKey === "industry"}
                    dir={sortDir}
                  >
                    Industry
                  </SortableTh>
                  <SortableTh
                    onClick={() => onSort("lead")}
                    active={sortKey === "lead"}
                    dir={sortDir}
                  >
                    Lead
                  </SortableTh>
                  <SortableTh
                    onClick={() => onSort("stage")}
                    active={sortKey === "stage"}
                    dir={sortDir}
                  >
                    Stage
                  </SortableTh>
                  <SortableTh
                    onClick={() => onSort("lastActivity")}
                    active={sortKey === "lastActivity"}
                    dir={sortDir}
                  >
                    Last activity
                  </SortableTh>
                  <SortableTh
                    onClick={() => onSort("status")}
                    active={sortKey === "status"}
                    dir={sortDir}
                  >
                    Status
                  </SortableTh>
                  <th className="text-right px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((e) => (
                  <tr
                    key={e.id}
                    className="border-t hover:bg-muted/20 cursor-pointer"
                    data-testid={`row-${e.id}`}
                    onClick={(ev) => {
                      // Avoid double-navigation when the explicit link is clicked.
                      if ((ev.target as HTMLElement).closest("a")) return;
                      window.location.href = `${import.meta.env.BASE_URL}engagements/${e.id}`;
                    }}
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/engagements/${e.id}`}
                        className="font-medium hover:text-primary"
                      >
                        {e.clientName}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {e.industry ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {e.sponsor || "—"}
                    </td>
                    <td className="px-4 py-3">
                      <StageBadge stage={e.overallStage ?? null} />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {e.lastActivityAt ? formatRelative(e.lastActivityAt) : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="secondary" className="capitalize">
                        {e.status.replace(/_/g, " ")}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/engagements/${e.id}`}
                        className="text-xs text-primary hover:underline"
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SortableTh({
  children,
  onClick,
  active,
  dir,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active: boolean;
  dir: "asc" | "desc";
}) {
  return (
    <th
      onClick={onClick}
      className="text-left px-4 py-3 cursor-pointer select-none"
    >
      <span className={active ? "text-foreground" : ""}>{children}</span>
      {active && <span className="ml-1 text-xs">{dir === "asc" ? "▲" : "▼"}</span>}
    </th>
  );
}

function StageBadge({ stage }: { stage: number | null }) {
  if (stage == null) {
    return (
      <Badge variant="outline" className="font-mono" data-testid="stage-badge-none">
        Not yet assessed
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="font-mono"
      style={{
        backgroundColor: stageColor(stage, 0.18),
        borderColor: stageColor(stage, 0.5),
        color: stageColor(stage, 1),
      }}
      data-testid={`stage-badge-${stage}`}
    >
      Stage {stage}
    </Badge>
  );
}

// Display the stage % share with one decimal when it isn't a whole number
// (so 2.5% and 0.5% from a 200-engagement book don't get rounded to "2%"
// and "0%"). Whole numbers stay clean: 31% rather than 31.0%.
function formatStagePercent(p: number): string {
  const value = (p ?? 0) * 100;
  const oneDecimal = Math.round(value * 10) / 10;
  return Number.isInteger(oneDecimal)
    ? `${oneDecimal}%`
    : `${oneDecimal.toFixed(1)}%`;
}

function formatMonthLabel(month: string): string {
  // Parse YYYY-MM. Avoid Date(month) because some browsers treat that as UTC
  // midnight on the 1st of that month, which is fine, but locale display is
  // friendlier via Intl.
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  return d.toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

function StallBadge({
  engagement,
  reason,
}: {
  engagement: PortfolioEngagement;
  reason: PortfolioStallReason;
}) {
  const className =
    "border-amber-500/40 text-amber-700 dark:text-amber-300 hover:bg-amber-500/10 cursor-pointer";

  let detail = "";
  let href = `/engagements/${engagement.id}`;

  if (reason === "stale_connectors") {
    href = `/engagements/${engagement.id}/connectors`;
    const d = daysSince(engagement.lastConnectorRunAt);
    detail = d == null ? "never synced" : `last sync ${d}d ago`;
  } else if (reason === "low_survey_response") {
    href = `/engagements/${engagement.id}/survey`;
    const pct = Math.round(engagement.surveyResponseRate * 100);
    detail = `${pct}% (${engagement.surveyCompleted}/${engagement.surveySent})`;
  } else if (reason === "no_finalized_deliverable") {
    href = `/engagements/${engagement.id}/exports`;
    const d = daysSince(engagement.lastActivityAt ?? engagement.createdAt);
    detail = d == null ? "none finalized" : `${d}d, none finalized`;
  }

  return (
    <Link href={href}>
      <Badge
        variant="outline"
        className={className}
        data-testid={`stall-badge-${engagement.id}-${reason}`}
        title={`Open ${STALL_LABEL[reason]} for ${engagement.clientName}`}
      >
        <span className="font-medium">{STALL_LABEL[reason]}</span>
        {detail && (
          <span className="ml-1.5 opacity-80 font-mono text-[10px]">
            · {detail}
          </span>
        )}
      </Badge>
    </Link>
  );
}
