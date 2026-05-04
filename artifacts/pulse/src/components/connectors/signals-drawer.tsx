import {
  useGetConnectorSignals,
  getGetConnectorSignalsQueryKey,
} from "@workspace/api-client-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatRelative } from "@/lib/format";

interface SignalsDrawerProps {
  connectorId: string | null;
  connectorLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// DORA metrics carried in `latestRun.summary` by the GitHub/GitLab/CI/Jira
// runners. Each field is optional — a connector that can't measure a metric
// (e.g. CircleCI cannot measure MTTR) leaves it `null` or absent and we
// render it as "n/a".
type DoraSummary = {
  deploysPerDay?: number | null;
  leadTimeHoursAvg?: number | null;
  changeFailureRate?: number | null;
  mttrHoursAvg?: number | null;
};

// Issue-tracking flow metrics emitted by Jira and Linear runners under the
// `issueTracking` key on `latestRun.summary`. Mirrors the IssueFlowMetrics
// shape on the server side. Every field can be null when the underlying
// signal isn't measurable (e.g. no sprint cadence).
interface PercentileTriple {
  p50: number | null;
  p75: number | null;
  p95: number | null;
}
interface IssueTrackingSummary {
  sampleSize?: number;
  cycleTimeHoursAvg?: number | null;
  leadTimeHoursAvg?: number | null;
  cycleTimeHoursPctl?: PercentileTriple;
  leadTimeHoursPctl?: PercentileTriple;
  flowEfficiencyPct?: number | null;
  blockedTimeHoursAvg?: number | null;
  throughputPerSprintAvg?: number | null;
  sprintCompletionRatePct?: number | null;
  sprintsObserved?: number;
  currentWip?: number;
  // Inspected sample size for aging-share — when smaller than `currentWip`
  // the aging count is a lower bound (we only scanned the oldest N items).
  currentWipSampled?: number;
  agingWipCount?: number;
  agingWipOldestDays?: number | null;
  issueTypeDistribution?: Record<string, number>;
  backlogSize?: number | null;
  // True when the paginated counter hit its hard cap; the figure should be
  // read as ≥ rather than =.
  backlogSizeCapped?: boolean;
  backlogGrowthCapped?: boolean;
  backlogGrowthPerDay?: number | null;
}

function formatHours(h: number | null | undefined): string {
  if (h === null || h === undefined) return "n/a";
  if (h < 1) return `${(h * 60).toFixed(0)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function formatPctlTriple(p: PercentileTriple | undefined): string {
  if (!p || p.p50 === null) return "n/a";
  return `${formatHours(p.p50)} / ${formatHours(p.p75)} / ${formatHours(p.p95)}`;
}

function formatPercent(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined) return "n/a";
  return `${v.toFixed(digits)}%`;
}

function DoraMetrics({ summary }: { summary: DoraSummary }) {
  // Render the four DORA proxies only if at least one is present in the
  // summary; otherwise this connector doesn't produce DORA-style signals
  // and we hide the section to avoid confusing assessors.
  const hasAny =
    summary.deploysPerDay != null ||
    summary.leadTimeHoursAvg != null ||
    summary.changeFailureRate != null ||
    "mttrHoursAvg" in summary;
  if (!hasAny) return null;
  const cells: Array<{ label: string; value: string; hint: string }> = [
    {
      label: "Deploy frequency",
      value:
        summary.deploysPerDay == null
          ? "n/a"
          : `${summary.deploysPerDay.toFixed(2)}/day`,
      hint: "Successful CI runs per day (30d)",
    },
    {
      label: "Lead time",
      value: formatHours(summary.leadTimeHoursAvg),
      hint: "Avg PR/MR open → merge",
    },
    {
      label: "Change failure rate",
      value:
        summary.changeFailureRate == null
          ? "n/a"
          : `${(summary.changeFailureRate * 100).toFixed(1)}%`,
      hint: "Failed runs ÷ total runs (30d)",
    },
    {
      label: "MTTR",
      value: formatHours(summary.mttrHoursAvg),
      hint: "Avg incident-issue close − open",
    },
  ];
  return (
    <section>
      <h3 className="text-sm font-semibold mb-2">DORA metrics</h3>
      <div className="grid grid-cols-2 gap-2">
        {cells.map((c) => (
          <div key={c.label} className="rounded border p-3">
            <div className="text-xs text-muted-foreground">{c.label}</div>
            <div className="text-lg font-semibold tabular-nums">{c.value}</div>
            <div className="text-xs text-muted-foreground">{c.hint}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function IssueTrackingMetrics({ summary }: { summary: IssueTrackingSummary }) {
  // Only render when the connector emitted an issueTracking block — Jira/
  // Linear runners always include it but the source-control runners don't,
  // and we don't want a tile of "n/a" cells on those.
  const dist = summary.issueTypeDistribution ?? {};
  const distTotal = Object.values(dist).reduce((a, b) => a + (b ?? 0), 0);
  const cells: Array<{ label: string; value: string; hint: string }> = [
    {
      label: "Cycle time (p50/p75/p95)",
      value: formatPctlTriple(summary.cycleTimeHoursPctl),
      hint: "First in-progress → done",
    },
    {
      label: "Lead time (p50/p75/p95)",
      value: formatPctlTriple(summary.leadTimeHoursPctl),
      hint: "Created → resolved",
    },
    {
      label: "Flow efficiency",
      value: formatPercent(summary.flowEfficiencyPct),
      hint: "Active ÷ (active+blocked+todo)",
    },
    {
      label: "Blocked time",
      value: formatHours(summary.blockedTimeHoursAvg),
      hint: "Avg per resolved issue",
    },
    {
      label: "Throughput",
      value:
        summary.throughputPerSprintAvg == null
          ? "n/a"
          : `${summary.throughputPerSprintAvg.toFixed(1)} issues`,
      hint:
        (summary.sprintsObserved ?? 0) > 0
          ? `Avg per sprint (n=${summary.sprintsObserved})`
          : "Per 2-week window",
    },
    {
      label: "Sprint completion",
      value:
        (summary.sprintsObserved ?? 0) > 0
          ? formatPercent(summary.sprintCompletionRatePct)
          : "no cadence",
      hint:
        (summary.sprintsObserved ?? 0) > 0
          ? `Across ${summary.sprintsObserved} closed sprints`
          : "Set up sprints/cycles to enable",
    },
    {
      label: "WIP",
      value:
        summary.currentWip == null
          ? "n/a"
          : `${summary.currentWip} (${summary.agingWipCount ?? 0}${
              summary.currentWipSampled != null &&
              summary.currentWip > 0 &&
              summary.currentWipSampled < summary.currentWip
                ? "+"
                : ""
            } aging)`,
      hint:
        summary.currentWipSampled != null &&
        summary.currentWip != null &&
        summary.currentWipSampled < summary.currentWip
          ? `Sampled ${summary.currentWipSampled} of ${summary.currentWip} (>14d = aging)`
          : summary.agingWipOldestDays != null
            ? `Oldest ${summary.agingWipOldestDays.toFixed(0)}d`
            : ">14 days = aging",
    },
    {
      label: "Backlog growth",
      value:
        summary.backlogGrowthPerDay == null
          ? "n/a"
          : `${
              summary.backlogGrowthCapped || summary.backlogSizeCapped ? "≥" : ""
            }${summary.backlogGrowthPerDay >= 0 ? "+" : ""}${summary.backlogGrowthPerDay.toFixed(2)}/day`,
      hint:
        summary.backlogSize != null
          ? `Backlog size ${summary.backlogSizeCapped ? "≥" : ""}${summary.backlogSize}`
          : "Net (created − resolved) ÷ 30",
    },
  ];
  return (
    <section>
      <h3 className="text-sm font-semibold mb-2">Issue Tracking</h3>
      <div className="grid grid-cols-2 gap-2">
        {cells.map((c) => (
          <div key={c.label} className="rounded border p-3">
            <div className="text-xs text-muted-foreground">{c.label}</div>
            <div className="text-lg font-semibold tabular-nums">{c.value}</div>
            <div className="text-xs text-muted-foreground">{c.hint}</div>
          </div>
        ))}
      </div>
      {distTotal > 0 ? (
        <div className="mt-2 rounded border p-3 text-xs">
          <div className="text-muted-foreground mb-1">
            Issue mix (n={distTotal})
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {(["bug", "feature", "tech_debt", "chore", "other"] as const).map(
              (k) => {
                const n = dist[k] ?? 0;
                if (n === 0) return null;
                const pct = (n / distTotal) * 100;
                return (
                  <span key={k} className="tabular-nums">
                    <span className="font-medium capitalize">
                      {k.replace("_", " ")}
                    </span>{" "}
                    {n} ({pct.toFixed(0)}%)
                  </span>
                );
              },
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function SignalsDrawer({
  connectorId,
  connectorLabel,
  open,
  onOpenChange,
}: SignalsDrawerProps) {
  const { data, isLoading } = useGetConnectorSignals(connectorId ?? "", {
    query: {
      enabled: open && Boolean(connectorId),
      queryKey: getGetConnectorSignalsQueryKey(connectorId ?? ""),
    },
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-xl overflow-hidden flex flex-col">
        <SheetHeader>
          <SheetTitle>Raw signals — {connectorLabel}</SheetTitle>
          <SheetDescription>
            Latest run summary and the evidence rows this connector authored.
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="flex-1 -mx-6 px-6 mt-4">
          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : !data ? (
            <p className="text-sm text-muted-foreground">
              No signals available yet. Run the connector to collect evidence.
            </p>
          ) : (
            <div className="space-y-6">
              <section>
                <h3 className="text-sm font-semibold mb-2">Latest run</h3>
                {data.latestRun ? (
                  <div className="rounded border p-3 text-sm space-y-1">
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={
                          data.latestRun.status === "success"
                            ? "default"
                            : data.latestRun.status === "failed"
                              ? "destructive"
                              : "secondary"
                        }
                      >
                        {data.latestRun.status}
                      </Badge>
                      <span className="text-muted-foreground">
                        {formatRelative(data.latestRun.startedAt)}
                      </span>
                    </div>
                    <div className="text-muted-foreground">
                      {data.latestRun.recordsCollected} records collected
                    </div>
                    {data.latestRun.error ? (
                      <div className="text-destructive">
                        {data.latestRun.error}
                      </div>
                    ) : null}
                    {data.latestRun.summary &&
                    Object.keys(data.latestRun.summary).length > 0 ? (
                      <pre className="text-xs bg-muted p-2 rounded overflow-x-auto mt-2">
                        {JSON.stringify(data.latestRun.summary, null, 2)}
                      </pre>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No runs yet.
                  </p>
                )}
              </section>
              {data.latestRun?.summary ? (
                <DoraMetrics
                  summary={data.latestRun.summary as DoraSummary}
                />
              ) : null}
              {data.latestRun?.summary &&
              "issueTracking" in
                (data.latestRun.summary as Record<string, unknown>) ? (
                <IssueTrackingMetrics
                  summary={
                    (data.latestRun.summary as { issueTracking: IssueTrackingSummary })
                      .issueTracking
                  }
                />
              ) : null}
              <section>
                <h3 className="text-sm font-semibold mb-2">
                  Evidence ({data.evidence.length})
                </h3>
                {data.evidence.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No evidence captured. The connector run did not detect
                    any usable signals.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {data.evidence.map((e) => (
                      <li
                        key={e.id}
                        className="rounded border p-3 text-sm space-y-1"
                      >
                        <div className="flex items-center gap-2 text-xs">
                          <Badge variant="outline" className="capitalize">
                            {e.dimension}
                          </Badge>
                          <Badge
                            variant={
                              e.signalType === "strength"
                                ? "default"
                                : e.signalType === "gap"
                                  ? "secondary"
                                  : e.signalType === "risk"
                                    ? "destructive"
                                    : "outline"
                            }
                          >
                            {e.signalType}
                          </Badge>
                          {typeof e.stageHint === "number" ? (
                            <span className="text-muted-foreground">
                              Stage {e.stageHint}
                            </span>
                          ) : null}
                          <span className="ml-auto text-muted-foreground">
                            {formatRelative(e.createdAt)}
                          </span>
                        </div>
                        <p>{e.text}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
