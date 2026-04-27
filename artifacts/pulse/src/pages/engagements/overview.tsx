import {
  useGetEngagement,
  useGetEngagementDashboard,
  useGetEngagementActivity,
  useGetMe,
  getGetEngagementQueryKey,
  getGetEngagementDashboardQueryKey,
  getGetEngagementActivityQueryKey,
} from "@workspace/api-client-react";
import type {
  ActivityEvent,
  GetEngagementActivityParams,
} from "@workspace/api-client-react";
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Download, AlertTriangle } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useParams } from "wouter";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { 
  Database, 
  FileText, 
  MessagesSquare, 
  Files, 
  Target, 
  Presentation,
  ArrowRight,
  Activity,
  Play
} from "lucide-react";
import { Link } from "wouter";
import { Progress } from "@/components/ui/progress";
import { MembersPanel } from "@/components/engagements/members-panel";

export default function EngagementOverview() {
  const params = useParams();
  const id = params.id as string;
  
  const { data: engagement, isLoading: isLoadingEngagement } = useGetEngagement(id, {
    query: { enabled: !!id, queryKey: getGetEngagementQueryKey(id) },
  });

  const { data: dashboard, isLoading: isLoadingDashboard } = useGetEngagementDashboard(id, {
    query: { enabled: !!id, queryKey: getGetEngagementDashboardQueryKey(id) },
  });

  const isLoading = isLoadingEngagement || isLoadingDashboard;

  return (
    <AppLayout engagementId={id}>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Workspace Overview</h1>
          <div className="text-muted-foreground mt-1 text-sm">
            {isLoading ? <Skeleton className="h-4 w-48" /> : `Status and progress for ${engagement?.clientName}`}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" className="gap-2">
            <Play className="h-4 w-4" />
            Run all connectors
          </Button>
          <Link href={`/engagements/${id}/exports`}>
            <Button className="gap-2">
              <FileText className="h-4 w-4" />
              Export Bundle
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 mb-8">
        {/* Connectors Tile */}
        <Card className="hover:border-primary/50 transition-colors">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <Database className="h-5 w-5 text-chart-1" />
                Connectors
              </CardTitle>
              <Link href={`/engagements/${id}/connectors`}>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary">
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
            <CardDescription>System integrations & automated data</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingDashboard ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <div className="flex items-end gap-2">
                <span className="text-3xl font-bold font-mono">{dashboard?.connectorsHealthy || 0}</span>
                <span className="text-muted-foreground mb-1">/ {dashboard?.connectorsTotal || 0} healthy</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Survey Tile */}
        <Card className="hover:border-primary/50 transition-colors">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <FileText className="h-5 w-5 text-chart-2" />
                Survey
              </CardTitle>
              <Link href={`/engagements/${id}/survey`}>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary">
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
            <CardDescription>Team perception & self-reporting</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingDashboard ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <div>
                <div className="flex items-end justify-between mb-2">
                  <div className="flex items-end gap-2">
                    <span className="text-3xl font-bold font-mono">{dashboard?.surveyCompleted || 0}</span>
                    <span className="text-muted-foreground mb-1">/ {dashboard?.surveySent || 0} responses</span>
                  </div>
                  <span className="text-sm font-medium">{Math.round((dashboard?.surveyResponseRate || 0) * 100)}%</span>
                </div>
                <Progress value={(dashboard?.surveyResponseRate || 0) * 100} className="h-2" />
              </div>
            )}
          </CardContent>
        </Card>

        {/* Interviews Tile */}
        <Card className="hover:border-primary/50 transition-colors">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <MessagesSquare className="h-5 w-5 text-chart-3" />
                Interviews
              </CardTitle>
              <Link href={`/engagements/${id}/interviews`}>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary">
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
            <CardDescription>Qualitative insights & context</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingDashboard ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <div className="flex items-end gap-2">
                <span className="text-3xl font-bold font-mono">{dashboard?.interviewsCompleted || 0}</span>
                <span className="text-muted-foreground mb-1">/ {dashboard?.interviewsTotal || 0} completed</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Artifacts Tile */}
        <Card className="hover:border-primary/50 transition-colors">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <Files className="h-5 w-5 text-chart-4" />
                Artifacts
              </CardTitle>
              <Link href={`/engagements/${id}/artifacts`}>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary">
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
            <CardDescription>Documents & diagrams</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingDashboard ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <div className="flex items-end gap-2">
                <span className="text-3xl font-bold font-mono">{dashboard?.artifactCount || 0}</span>
                <span className="text-muted-foreground mb-1">documents collected</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Scoring Tile */}
        <Card className="hover:border-primary/50 transition-colors bg-secondary/30">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <Target className="h-5 w-5 text-primary" />
                Scoring
              </CardTitle>
              <Link href={`/engagements/${id}/scoring`}>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary">
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
            <CardDescription>Dimension evaluation & overrides</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingDashboard ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <div className="flex flex-col gap-1 text-sm">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Activity className="h-4 w-4" />
                  <span>Based on {dashboard?.evidenceCount || 0} pieces of evidence</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Deliverables Tile */}
        <Card className="hover:border-primary/50 transition-colors bg-primary/5 border-primary/20">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2 text-primary">
                <Presentation className="h-5 w-5" />
                Deliverables
              </CardTitle>
              <Link href={`/engagements/${id}/results/heatmap`}>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-primary hover:text-primary/80">
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
            <CardDescription className="text-primary/70">Final outputs & recommendations</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingDashboard ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <div className="grid grid-cols-2 gap-2 text-xs">
                {Object.entries(dashboard?.deliverableStatuses || {}).map(([key, status]) => (
                  <div key={key} className="flex items-center justify-between p-1.5 bg-background rounded border">
                    <span className="capitalize">{key.replace(/([A-Z])/g, ' $1').trim()}</span>
                    <div className={`h-2 w-2 rounded-full ${
                      status === 'locked' ? 'bg-green-500' :
                      status === 'reviewed' ? 'bg-blue-500' : 'bg-muted-foreground/30'
                    }`} />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <MembersPanel engagementId={id} />

      <ActivityFeed engagementId={id} />
    </AppLayout>
  );
}

function ActivityFeed({ engagementId }: { engagementId: string }) {
  const [actor, setActor] = useState("");
  const [severity, setSeverity] = useState<"all" | "critical" | "info">("all");
  const [kind, setKind] = useState<string>("all");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [showRaw, setShowRaw] = useState<string | null>(null);

  const { data: me } = useGetMe();
  const isAdmin = me?.role === "admin";

  // Filter params are sent as a single object so the query key changes when
  // any filter does — react-query refetches automatically. `limit` is bumped
  // to give the audit reviewer more history than the default dashboard view.
  // Date inputs (`yyyy-mm-dd`) are converted to ISO timestamps so the server
  // gets a precise range; from = start-of-day, to = end-of-day.
  const params = useMemo<GetEngagementActivityParams>(() => {
    const p: GetEngagementActivityParams = { limit: 200 };
    if (actor.trim()) p.actor = actor.trim();
    if (severity !== "all") p.severity = severity;
    if (kind !== "all") p.kind = kind;
    if (from) p.from = new Date(`${from}T00:00:00`).toISOString();
    if (to) p.to = new Date(`${to}T23:59:59.999`).toISOString();
    return p;
  }, [actor, severity, kind, from, to]);

  const { data: events, isLoading } = useGetEngagementActivity(
    engagementId,
    params,
    {
      query: {
        enabled: !!engagementId,
        queryKey: getGetEngagementActivityQueryKey(engagementId, params),
      },
    },
  );

  const downloadCsv = () => {
    const qs = new URLSearchParams();
    if (params.actor) qs.set("actor", params.actor);
    if (params.severity) qs.set("severity", params.severity);
    if (params.kind) qs.set("kind", params.kind);
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    // Open in a new tab so the browser handles the file download cookie/auth.
    const url = `/api/engagements/${engagementId}/activity.csv${qs.toString() ? `?${qs}` : ""}`;
    window.open(url, "_blank");
  };

  // Build the kind dropdown from the events that came back so it stays in
  // sync with the schema as new event types are added on the backend.
  const kindOptions = useMemo(() => {
    const set = new Set<string>();
    (events ?? []).forEach((e: ActivityEvent) => set.add(e.kind));
    return Array.from(set).sort();
  }, [events]);

  const initials = (s: string) =>
    s
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? "")
      .join("") || "?";

  return (
    <Card className="mt-8">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <Activity className="h-5 w-5 text-primary" />
              Activity timeline
            </CardTitle>
            <CardDescription>
              Filter the audit log by actor or severity. Critical events are
              flagged for compliance review.
            </CardDescription>
          </div>
          {isAdmin ? (
            <Button
              variant="outline"
              size="sm"
              onClick={downloadCsv}
              data-testid="button-activity-csv"
            >
              <Download className="h-4 w-4 mr-1.5" />
              CSV
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2 pt-3">
          <Input
            placeholder="Filter by actor name or email"
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            className="max-w-xs h-8 text-sm"
            data-testid="input-activity-actor"
          />
          <Select
            value={severity}
            onValueChange={(v) => setSeverity(v as typeof severity)}
          >
            <SelectTrigger
              className="w-[140px] h-8 text-sm"
              data-testid="select-activity-severity"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All severities</SelectItem>
              <SelectItem value="critical">Critical only</SelectItem>
              <SelectItem value="info">Info only</SelectItem>
            </SelectContent>
          </Select>
          <Select value={kind} onValueChange={(v) => setKind(v)}>
            <SelectTrigger
              className="w-[180px] h-8 text-sm"
              data-testid="select-activity-kind"
            >
              <SelectValue placeholder="All actions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All actions</SelectItem>
              {kindOptions.map((k) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-[150px] h-8 text-sm"
            aria-label="From date"
            data-testid="input-activity-from"
          />
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-[150px] h-8 text-sm"
            aria-label="To date"
            data-testid="input-activity-to"
          />
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : !events || events.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No activity matches these filters.
          </p>
        ) : (
          <ul className="space-y-3">
            {events.map((e: ActivityEvent) => {
              const actorLabel = e.actorName || e.actorEmail || "System";
              const isCritical = e.severity === "critical";
              const hasPayload =
                e.payload && Object.keys(e.payload).length > 0;
              return (
                <li
                  key={e.id}
                  className={`flex items-start gap-3 text-sm rounded-md p-2 -mx-2 ${
                    isCritical ? "bg-amber-500/5" : ""
                  }`}
                  data-testid={`activity-event-${e.id}`}
                >
                  <Avatar className="h-7 w-7 mt-0.5">
                    {e.actorAvatarUrl ? (
                      <AvatarImage src={e.actorAvatarUrl} alt={actorLabel} />
                    ) : null}
                    <AvatarFallback className="text-xs">
                      {initials(actorLabel)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="font-medium">{actorLabel}</span>
                      {isCritical ? (
                        <span
                          className="rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide flex items-center gap-0.5"
                          data-testid={`badge-critical-${e.id}`}
                        >
                          <AlertTriangle className="h-3 w-3" />
                          Critical
                        </span>
                      ) : null}
                      <span className="text-[10px] font-mono text-muted-foreground/70 uppercase">
                        {e.kind}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(e.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <p className="text-muted-foreground">{e.message}</p>
                    {hasPayload ? (
                      <button
                        type="button"
                        onClick={() =>
                          setShowRaw(showRaw === e.id ? null : e.id)
                        }
                        className="text-[11px] text-muted-foreground/70 hover:text-foreground underline-offset-2 hover:underline mt-1"
                        data-testid={`button-toggle-payload-${e.id}`}
                      >
                        {showRaw === e.id ? "Hide details" : "Show details"}
                      </button>
                    ) : null}
                    {showRaw === e.id ? (
                      <pre className="mt-1 text-[11px] bg-muted/50 rounded p-2 overflow-x-auto">
                        {JSON.stringify(
                          { payload: e.payload, requestId: e.requestId },
                          null,
                          2,
                        )}
                      </pre>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
