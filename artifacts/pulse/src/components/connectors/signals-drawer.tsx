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
  leadTimeHoursP50?: number | null;
  leadTimeHoursP75?: number | null;
  leadTimeHoursP95?: number | null;
  leadTimeUnavailableReason?: string | null;
  changeFailureRate?: number | null;
  mttrHoursAvg?: number | null;
  mttrHoursP50?: number | null;
  mttrHoursP95?: number | null;
  mttrSource?:
    | "deployment_failure"
    | "incident_issue_fallback"
    | "unavailable"
    | string
    | null;
};

// PRD §6.2 CI/CD metrics. All fields optional — connectors that can't
// observe a particular metric set the value to null and (when helpful)
// pair it with an `*UnavailableReason` string the UI can show as a hint.
type CiCdSummary = {
  buildDurationMinutesP50?: number | null;
  buildDurationMinutesP75?: number | null;
  buildDurationMinutesP95?: number | null;
  buildDurationSampleSize?: number | null;
  buildDurationUnit?: string | null;
  queueTimeMinutesP50?: number | null;
  queueTimeMinutesP75?: number | null;
  queueTimeSampleSize?: number | null;
  queueTimeUnit?: string | null;
  queueTimeUnavailableReason?: string | null;
  buildSuccessRate?: number | null;
  flakyTestRate?: number | null;
  flakyRetrySuccesses30d?: number | null;
  flakyDenominator30d?: number | null;
  flakyDenominatorUnit?: string | null;
  runsWithRetries30d?: number | null;
  flakyTestRateUnavailableReason?: string | null;
  jobsObserved30d?: number | null;
  jobRunsSampled30d?: number | null;
  workflowsInspectedForJobs30d?: number | null;
  jobSampleTruncated?: boolean | null;
  jobSampleTruncatedReason?: string | null;
  leadTimeHoursP50?: number | null;
  leadTimeHoursP75?: number | null;
  leadTimeHoursP95?: number | null;
  leadTimeUnavailableReason?: string | null;
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

// Source-control metrics produced by the GitHub/GitLab runners
// (PRD §6.2). All fields are optional — runners that haven't been
// extended yet, or runs against empty repos, leave them absent and we
// render the corresponding cell as "n/a".
type ScSizeBucket = "xs" | "s" | "m" | "l" | "xl";
type ScSummary = {
  prThroughput30d?: number | null;
  leadTimeHoursP50?: number | null;
  leadTimeHoursP75?: number | null;
  leadTimeHoursP95?: number | null;
  timeToFirstReviewHoursP50?: number | null;
  timeToFirstReviewHoursP75?: number | null;
  timeToFirstReviewHoursP95?: number | null;
  reviewTurnaroundHoursP50?: number | null;
  reviewTurnaroundHoursP75?: number | null;
  reviewTurnaroundHoursP95?: number | null;
  commentsPerPRAvg?: number | null;
  reviewIterationsAvg?: number | null;
  prSizeDistribution?: Record<ScSizeBucket, number> | null;
  commitsPerDay?: number | null;
  reworkRate?: number | null;
  busFactor?: number | null;
  branchLifespanHoursAvg?: number | null;
  branchLifespanHoursP50?: number | null;
  branchLifespanHoursP95?: number | null;
  prsSampledForDetail?: number | null;
  prsAttemptedForDetail?: number | null;
  prsAvailableForDetail?: number | null;
};

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

function formatMinutes(m: number | null | undefined): string {
  if (m === null || m === undefined) return "n/a";
  if (m < 1) return `${(m * 60).toFixed(1)}s`;
  if (m < 60) return `${m.toFixed(1)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

function formatRate(r: number | null | undefined): string {
  if (r === null || r === undefined) return "n/a";
  return `${(r * 100).toFixed(1)}%`;
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
  // MTTR hint surfaces provenance per PRD: the assessor needs to know
  // whether the number came from real deploy failure→success pairs or
  // from the incident-issue proxy.
  const mttrHint =
    summary.mttrSource === "deployment_failure"
      ? "Avg deploy failure → next success"
      : summary.mttrSource === "incident_issue_fallback"
        ? "Fallback: avg incident-issue close − open"
        : summary.mttrSource === "unavailable"
          ? "No deploy failures or incident issues observed"
          : "Avg incident-issue close − open";
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
      hint: mttrHint,
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
      {/* MTTR percentile detail (only when deploy-failure-driven). */}
      {summary.mttrSource === "deployment_failure" &&
      (summary.mttrHoursP50 != null || summary.mttrHoursP95 != null) ? (
        <p className="mt-2 text-xs text-muted-foreground">
          MTTR p50 {formatHours(summary.mttrHoursP50)} / p95{" "}
          {formatHours(summary.mttrHoursP95)} across deploy failure→success
          pairs.
        </p>
      ) : null}
    </section>
  );
}

// PRD §6.2 CI/CD subgroup: build duration percentiles, queue time
// percentiles, build success rate, flaky-test rate, and lead-time
// percentiles. Renders n/a (with the connector-supplied reason when
// available) for any metric the connector couldn't observe.
function CiCdMetrics({ summary }: { summary: CiCdSummary }) {
  const hasAny =
    summary.buildDurationMinutesP50 != null ||
    summary.buildDurationMinutesP75 != null ||
    summary.buildDurationMinutesP95 != null ||
    summary.queueTimeMinutesP50 != null ||
    summary.queueTimeMinutesP75 != null ||
    summary.buildSuccessRate != null ||
    summary.flakyTestRate != null ||
    summary.leadTimeHoursP50 != null ||
    summary.leadTimeHoursP75 != null ||
    summary.leadTimeHoursP95 != null ||
    "queueTimeUnavailableReason" in summary ||
    "flakyTestRateUnavailableReason" in summary ||
    "leadTimeUnavailableReason" in summary;
  if (!hasAny) return null;
  // Hint must reflect the actual backend formula, which is harmonized
  // across providers as `flakyRetrySuccesses30d / flakyDenominator30d`
  // where the denominator unit (workflow_runs / job_groups / workflows)
  // varies by provider but the ratio is comparable.
  const flakyUnitLabel =
    summary.flakyDenominatorUnit === "jobs"
      ? "jobs"
      : summary.flakyDenominatorUnit === "job_groups"
        ? "job groups"
        : summary.flakyDenominatorUnit === "workflows"
          ? "workflows"
          : summary.flakyDenominatorUnit === "workflow_runs"
            ? "workflow runs"
            : "runs";
  const truncationNote = summary.jobSampleTruncated
    ? ` (sample truncated: ${summary.jobSampleTruncatedReason ?? "API budget cap"})`
    : "";
  const flakyHint =
    summary.flakyTestRate != null &&
    summary.flakyRetrySuccesses30d != null &&
    summary.flakyDenominator30d != null
      ? `${summary.flakyRetrySuccesses30d}/${summary.flakyDenominator30d} ${flakyUnitLabel} passed on retry of same SHA (30d)${truncationNote}`
      : (summary.flakyTestRateUnavailableReason ??
        "Jobs that pass on retry of the same SHA");
  // Sample-size suffixes make the percentile cells self-explanatory:
  // assessors see at a glance how trustworthy each percentile is and what
  // unit was sampled (jobs / workflow runs / workflows / pipelines).
  const buildUnitLabel = summary.buildDurationUnit ?? "runs";
  const queueUnitLabel = summary.queueTimeUnit ?? "runs";
  const buildSampleSuffix =
    summary.buildDurationSampleSize != null
      ? ` (n=${summary.buildDurationSampleSize} ${buildUnitLabel})`
      : "";
  const queueSampleSuffix =
    summary.queueTimeSampleSize != null
      ? ` (n=${summary.queueTimeSampleSize} ${queueUnitLabel})`
      : "";
  const cells: Array<{ label: string; value: string; hint: string }> = [
    {
      label: "Build duration p50",
      value: formatMinutes(summary.buildDurationMinutesP50),
      hint: `Median CI build wall time, 30d${buildSampleSuffix}`,
    },
    {
      label: "Build duration p75",
      value: formatMinutes(summary.buildDurationMinutesP75),
      hint: `75th-percentile CI build wall time${buildSampleSuffix}`,
    },
    {
      label: "Build duration p95",
      value: formatMinutes(summary.buildDurationMinutesP95),
      hint: `95th-percentile CI build wall time${buildSampleSuffix}`,
    },
    {
      label: "Queue time p50",
      value: formatMinutes(summary.queueTimeMinutesP50),
      hint:
        summary.queueTimeMinutesP50 == null &&
        summary.queueTimeUnavailableReason
          ? summary.queueTimeUnavailableReason
          : `Median wait before runner pickup, 30d${queueSampleSuffix}`,
    },
    {
      label: "Queue time p75",
      value: formatMinutes(summary.queueTimeMinutesP75),
      hint:
        summary.queueTimeMinutesP75 == null &&
        summary.queueTimeUnavailableReason
          ? summary.queueTimeUnavailableReason
          : `75th-percentile wait before runner pickup${queueSampleSuffix}`,
    },
    {
      label: "Build success rate",
      value: formatRate(summary.buildSuccessRate),
      hint: "Successful runs ÷ total (30d)",
    },
    {
      label: `Flaky-test rate (${flakyUnitLabel})`,
      value: formatRate(summary.flakyTestRate),
      hint: flakyHint,
    },
    {
      label: "Lead time p50",
      value: formatHours(summary.leadTimeHoursP50),
      hint:
        summary.leadTimeHoursP50 == null && summary.leadTimeUnavailableReason
          ? summary.leadTimeUnavailableReason
          : "Median PR/MR open → merge",
    },
    {
      label: "Lead time p75",
      value: formatHours(summary.leadTimeHoursP75),
      hint:
        summary.leadTimeHoursP75 == null && summary.leadTimeUnavailableReason
          ? summary.leadTimeUnavailableReason
          : "75th-percentile PR/MR open → merge",
    },
    {
      label: "Lead time p95",
      value: formatHours(summary.leadTimeHoursP95),
      hint:
        summary.leadTimeHoursP95 == null && summary.leadTimeUnavailableReason
          ? summary.leadTimeUnavailableReason
          : "95th-percentile PR/MR open → merge",
    },
  ];
  return (
    <section>
      <h3 className="text-sm font-semibold mb-2">CI/CD</h3>
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

function SourceControlMetrics({ summary }: { summary: ScSummary }) {
  // Show the section if any source-control metric is present. Cells are
  // independently nullable so partial data (e.g. PRs but no commits)
  // still renders gracefully.
  const hasAny =
    summary.prThroughput30d != null ||
    summary.leadTimeHoursP50 != null ||
    summary.timeToFirstReviewHoursP50 != null ||
    summary.reviewTurnaroundHoursP50 != null ||
    summary.commentsPerPRAvg != null ||
    summary.reviewIterationsAvg != null ||
    summary.commitsPerDay != null ||
    summary.reworkRate != null ||
    summary.busFactor != null ||
    summary.branchLifespanHoursAvg != null ||
    (summary.prSizeDistribution != null &&
      Object.values(summary.prSizeDistribution).some((v) => v > 0));
  if (!hasAny) return null;

  const fmtPct = (v: number | null | undefined) =>
    v == null ? "n/a" : `${(v * 100).toFixed(0)}%`;
  const fmtNum = (v: number | null | undefined, digits = 1) =>
    v == null ? "n/a" : v.toFixed(digits);

  const cells: Array<{ label: string; value: string; hint: string }> = [
    {
      label: "PR throughput",
      value:
        summary.prThroughput30d == null
          ? "n/a"
          : `${summary.prThroughput30d}/30d`,
      hint: "Merged PRs in the last 30 days",
    },
    {
      label: "Lead time (p50/p75/p95)",
      value: `${formatHours(summary.leadTimeHoursP50)} / ${formatHours(summary.leadTimeHoursP75)} / ${formatHours(summary.leadTimeHoursP95)}`,
      hint: "PR open → merge",
    },
    {
      label: "Time to first review (p50/p75/p95)",
      value: `${formatHours(summary.timeToFirstReviewHoursP50)} / ${formatHours(summary.timeToFirstReviewHoursP75)} / ${formatHours(summary.timeToFirstReviewHoursP95)}`,
      hint: "PR open → first reviewer comment",
    },
    {
      label: "Review turnaround (p50/p75/p95)",
      value: `${formatHours(summary.reviewTurnaroundHoursP50)} / ${formatHours(summary.reviewTurnaroundHoursP75)} / ${formatHours(summary.reviewTurnaroundHoursP95)}`,
      hint: "First review → merge",
    },
    {
      label: "Comments per PR",
      value: fmtNum(summary.commentsPerPRAvg, 1),
      hint: "Avg reviewer comments per PR",
    },
    {
      label: "Review iterations",
      value: fmtNum(summary.reviewIterationsAvg, 1),
      hint: "Avg review submissions per PR",
    },
    {
      label: "Commits per day",
      value: fmtNum(summary.commitsPerDay, 1),
      hint: "Across sampled repos (30d)",
    },
    {
      label: "Rework rate",
      value: fmtPct(summary.reworkRate),
      hint: "PRs with commits after first review",
    },
    {
      label: "Bus factor",
      value:
        summary.busFactor == null ? "n/a" : `${summary.busFactor} contributor${summary.busFactor === 1 ? "" : "s"}`,
      hint: "Authors covering ≥50% of commits",
    },
    {
      label: "Branch lifespan (p50/p95)",
      value: `${formatHours(summary.branchLifespanHoursP50)} / ${formatHours(summary.branchLifespanHoursP95)}`,
      hint: "First commit → merge",
    },
  ];

  // PR size distribution gets its own row — five buckets are noisy in
  // the 2-col grid and a horizontal stacked-bar reads more clearly.
  const dist = summary.prSizeDistribution;
  const distTotal = dist
    ? dist.xs + dist.s + dist.m + dist.l + dist.xl
    : 0;

  return (
    <section>
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-sm font-semibold">Source control</h3>
        {summary.prsSampledForDetail != null &&
        summary.prsAvailableForDetail != null ? (
          <span className="text-xs text-muted-foreground">
            sampled {summary.prsSampledForDetail}
            {summary.prsAttemptedForDetail != null &&
            summary.prsAttemptedForDetail !== summary.prsSampledForDetail
              ? ` of ${summary.prsAttemptedForDetail} attempted`
              : ""}{" "}
            / {summary.prsAvailableForDetail} PRs
          </span>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {cells.map((c) => (
          <div key={c.label} className="rounded border p-3">
            <div className="text-xs text-muted-foreground">{c.label}</div>
            <div className="text-lg font-semibold tabular-nums">{c.value}</div>
            <div className="text-xs text-muted-foreground">{c.hint}</div>
          </div>
        ))}
      </div>
      {dist && distTotal > 0 ? (
        <div className="rounded border p-3 mt-2">
          <div className="text-xs text-muted-foreground mb-2">
            PR size distribution (xs ≤10 / s ≤50 / m ≤250 / l ≤1000 / xl
            &gt;1000 lines)
          </div>
          <div className="flex h-2 rounded overflow-hidden bg-muted">
            {(["xs", "s", "m", "l", "xl"] as const).map((b, i) => {
              const pct = (dist[b] / distTotal) * 100;
              if (pct === 0) return null;
              const bg = [
                "bg-emerald-500",
                "bg-sky-500",
                "bg-amber-500",
                "bg-orange-500",
                "bg-rose-500",
              ][i];
              return (
                <div
                  key={b}
                  className={bg}
                  style={{ width: `${pct}%` }}
                  title={`${b}: ${dist[b]} (${pct.toFixed(0)}%)`}
                />
              );
            })}
          </div>
          <div className="flex justify-between text-xs text-muted-foreground mt-2 tabular-nums">
            {(["xs", "s", "m", "l", "xl"] as const).map((b) => (
              <span key={b}>
                {b}: {dist[b]}
              </span>
            ))}
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
              {data.latestRun?.summary ? (
                <CiCdMetrics
                  summary={data.latestRun.summary as CiCdSummary}
                />
              ) : null}
              {data.latestRun?.summary ? (
                <SourceControlMetrics
                  summary={data.latestRun.summary as ScSummary}
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
