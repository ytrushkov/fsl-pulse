import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useGetPortfolioSummary,
  useGetPortfolioHeatmap,
  useGetMe,
  PortfolioSizeBand,
  type PortfolioStallReason,
  type PortfolioEngagement,
} from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Input } from "@/components/ui/input";
import { Download, AlertTriangle, ShieldCheck } from "lucide-react";
import { formatRelative } from "@/lib/format";

const ALL = "__all__";

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

const DIM_LABEL: Record<string, string> = {
  tooling: "Tooling",
  measurement: "Measurement",
  process: "Process",
  people: "People",
  governance: "Governance",
  culture: "Culture",
};

const STAGE_COLORS = [
  "bg-muted text-muted-foreground",
  "bg-red-500/15 text-red-600 dark:text-red-300",
  "bg-orange-500/15 text-orange-600 dark:text-orange-300",
  "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  "bg-lime-500/15 text-lime-700 dark:text-lime-300",
  "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300",
];

function stageColor(stage: number | null | undefined): string {
  if (stage == null) return STAGE_COLORS[0];
  const i = Math.max(0, Math.min(5, Math.round(stage)));
  return STAGE_COLORS[i];
}

export default function PortfolioPage() {
  const [industry, setIndustry] = useState<string>(ALL);
  const [size, setSize] = useState<string>(ALL);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const params = useMemo(() => {
    const p: Record<string, string> = {};
    if (industry !== ALL) p.industry = industry;
    if (size !== ALL) p.size = size;
    if (from) p.from = new Date(from).toISOString();
    if (to) p.to = new Date(to).toISOString();
    return p;
  }, [industry, size, from, to]);

  const { data: summary, isLoading: loadingSummary } = useGetPortfolioSummary(params);
  const { data: heatmap, isLoading: loadingHeatmap } = useGetPortfolioHeatmap(params);
  const { data: me } = useGetMe();
  const isAdmin = me?.role === "admin";

  const benchmarkUrl = `${import.meta.env.BASE_URL}api/portfolio/benchmark.csv`;

  const engagements = summary?.engagements ?? [];
  const stalled = engagements.filter((e) => e.stallReasons.length > 0);

  return (
    <AppLayout>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Portfolio</h1>
          <p className="text-muted-foreground mt-1">
            Cross-engagement view of your maturity assessments — patterns, stalled work, and benchmarks.
          </p>
        </div>
        {isAdmin && (
          <a href={benchmarkUrl} target="_blank" rel="noopener noreferrer">
            <Button variant="outline" data-testid="button-export-benchmark">
              <Download className="mr-2 h-4 w-4" />
              Benchmark CSV
            </Button>
          </a>
        )}
      </div>

      {/* Filters */}
      <Card className="mb-6">
        <CardContent className="flex flex-wrap items-end gap-4 pt-6">
          <div className="min-w-[180px] flex-1">
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
          <div className="min-w-[160px] flex-1">
            <label className="block text-xs font-medium mb-1 text-muted-foreground">
              Engagement size
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
          <div className="min-w-[160px] flex-1">
            <label className="block text-xs font-medium mb-1 text-muted-foreground">
              From
            </label>
            <Input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              data-testid="input-from"
            />
          </div>
          <div className="min-w-[160px] flex-1">
            <label className="block text-xs font-medium mb-1 text-muted-foreground">
              To
            </label>
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              data-testid="input-to"
            />
          </div>
          {(industry !== ALL || size !== ALL || from || to) && (
            <Button
              variant="ghost"
              onClick={() => {
                setIndustry(ALL);
                setSize(ALL);
                setFrom("");
                setTo("");
              }}
            >
              Clear
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <StatCard
          label="Engagements in scope"
          value={loadingSummary ? "—" : engagements.length.toString()}
        />
        <StatCard
          label="Stalled engagements"
          value={loadingSummary ? "—" : stalled.length.toString()}
          tone={stalled.length > 0 ? "warn" : "ok"}
        />
        <StatCard
          label="Anonymity floor"
          value={`≥ ${heatmap?.anonymityFloor ?? 5}`}
          subtitle="Cells below the floor are suppressed"
        />
      </div>

      {/* Heatmap */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-lg">Cross-engagement maturity heatmap</CardTitle>
        </CardHeader>
        <CardContent>
          {loadingHeatmap ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              {(heatmap?.cells ?? []).map((cell) => (
                <div
                  key={cell.dimension}
                  className={`rounded-lg p-4 border ${stageColor(cell.meanStage)}`}
                  data-testid={`heatmap-cell-${cell.dimension}`}
                >
                  <div className="text-xs font-semibold uppercase tracking-wide opacity-80">
                    {DIM_LABEL[cell.dimension] ?? cell.dimension}
                  </div>
                  <div className="text-2xl font-bold mt-2 font-mono">
                    {cell.suppressed
                      ? "—"
                      : cell.meanStage != null
                        ? cell.meanStage.toFixed(1)
                        : "—"}
                  </div>
                  <div className="text-xs mt-1 opacity-70">
                    {cell.suppressed ? (
                      <span className="inline-flex items-center gap-1">
                        <ShieldCheck className="h-3 w-3" />
                        Suppressed
                      </span>
                    ) : (
                      `${cell.count} signal${cell.count === 1 ? "" : "s"}`
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Stalled widget */}
      {stalled.length > 0 && (
        <Card className="mb-6 border-amber-500/40">
          <CardHeader className="flex flex-row items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            <CardTitle className="text-lg">Stalled engagements</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {stalled.map((e) => (
                <li key={e.id} className="py-3 flex items-center justify-between">
                  <Link
                    href={`/engagements/${e.id}`}
                    className="font-medium hover:text-primary"
                  >
                    {e.clientName}
                  </Link>
                  <div className="flex flex-wrap gap-1">
                    {e.stallReasons.map((r) => (
                      <Badge
                        key={r}
                        variant="outline"
                        className="border-amber-500/40 text-amber-700 dark:text-amber-300"
                      >
                        {STALL_LABEL[r]}
                      </Badge>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Engagement list */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Engagements</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loadingSummary ? (
            <div className="p-6 space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : engagements.length === 0 ? (
            <div className="p-10 text-center text-muted-foreground">
              No engagements match the current filters.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="text-left px-4 py-3">Client</th>
                    <th className="text-left px-4 py-3">Industry</th>
                    <th className="text-left px-4 py-3">Size</th>
                    <th className="text-left px-4 py-3">Status</th>
                    <th className="text-right px-4 py-3">Stage</th>
                    <th className="text-right px-4 py-3">Survey</th>
                    <th className="text-right px-4 py-3">Connectors</th>
                    <th className="text-right px-4 py-3">Finalized</th>
                    <th className="text-left px-4 py-3">Last activity</th>
                  </tr>
                </thead>
                <tbody>
                  {engagements.map((e: PortfolioEngagement) => (
                    <tr key={e.id} className="border-t hover:bg-muted/20" data-testid={`row-${e.id}`}>
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
                      <td className="px-4 py-3">
                        <Badge variant="outline" className="capitalize">
                          {e.sizeBand}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="secondary" className="capitalize">
                          {e.status.replace(/_/g, " ")}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {e.overallStage != null ? e.overallStage : "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {e.surveySent === 0
                          ? "—"
                          : `${Math.round(e.surveyResponseRate * 100)}%`}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {e.connectorsTotal === 0
                          ? "—"
                          : `${e.connectorsHealthy}/${e.connectorsTotal}`}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {e.finalizedDeliverableCount}/{e.totalDeliverableCount}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {e.lastActivityAt
                          ? formatRelative(e.lastActivityAt)
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </AppLayout>
  );
}

function StatCard({
  label,
  value,
  subtitle,
  tone,
}: {
  label: string;
  value: string;
  subtitle?: string;
  tone?: "ok" | "warn";
}) {
  const ring =
    tone === "warn"
      ? "border-amber-500/40"
      : tone === "ok"
        ? "border-emerald-500/30"
        : "";
  return (
    <Card className={ring}>
      <CardContent className="pt-6">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <div className="text-3xl font-bold mt-1">{value}</div>
        {subtitle && (
          <div className="text-xs text-muted-foreground mt-1">{subtitle}</div>
        )}
      </CardContent>
    </Card>
  );
}
