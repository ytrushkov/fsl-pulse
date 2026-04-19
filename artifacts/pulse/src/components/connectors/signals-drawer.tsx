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

function formatHours(h: number | null | undefined): string {
  if (h === null || h === undefined) return "n/a";
  if (h < 1) return `${(h * 60).toFixed(0)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
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
