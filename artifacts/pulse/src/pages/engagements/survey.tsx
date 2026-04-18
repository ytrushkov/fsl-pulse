import { useState } from "react";
import { useParams } from "wouter";
import {
  useGetSurvey,
  useUpdateSurvey,
  useGetSurveyAggregates,
  useCreateSurveyInvites,
  usePreviewSurveyInvites,
  useCloseSurvey,
  getGetSurveyQueryKey,
  getGetSurveyAggregatesQueryKey,
  getListSurveyInvitesQueryKey,
} from "@workspace/api-client-react";
import type { InvitePreview } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Send,
  Users,
  LayoutList,
  Lock,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";

export default function SurveyView() {
  const params = useParams();
  const id = params.id as string;
  const [activeTab, setActiveTab] = useState("builder");

  return (
    <AppLayout engagementId={id}>
      <SurveyHeader engagementId={id} />

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-6">
          <TabsTrigger value="builder" className="gap-2">
            <LayoutList className="h-4 w-4" /> Builder
          </TabsTrigger>
          <TabsTrigger value="responses" className="gap-2">
            <Users className="h-4 w-4" /> Responses
          </TabsTrigger>
        </TabsList>

        <TabsContent value="builder">
          <SurveyBuilder engagementId={id} />
        </TabsContent>

        <TabsContent value="responses">
          <SurveyResponses engagementId={id} />
        </TabsContent>
      </Tabs>
    </AppLayout>
  );
}

function SurveyHeader({ engagementId }: { engagementId: string }) {
  const { data: survey } = useGetSurvey(engagementId, {
    query: { enabled: !!engagementId, queryKey: getGetSurveyQueryKey(engagementId) },
  });
  const closed = !!survey?.closedAt;

  return (
    <div className="flex items-center justify-between mb-8">
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold tracking-tight">Survey</h1>
          {closed && (
            <Badge variant="secondary" className="gap-1" data-testid="badge-survey-closed">
              <Lock className="h-3 w-3" /> Closed
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground mt-1">
          Configure assessment questionnaire and analyze responses.
        </p>
      </div>
      <div className="flex gap-2">
        {!closed && <DistributeDialog engagementId={engagementId} />}
        {!closed && <CloseSurveyButton engagementId={engagementId} />}
      </div>
    </div>
  );
}

function CloseSurveyButton({ engagementId }: { engagementId: string }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const closeSurvey = useCloseSurvey();

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" className="gap-2" data-testid="button-close-survey">
          <Lock className="h-4 w-4" /> Close Survey
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Close this survey?</AlertDialogTitle>
          <AlertDialogDescription>
            Closing locks the dataset for scoring. New responses will be
            rejected, magic links will show a "closed" message, and no further
            invites can be sent. This action can only be reversed by reopening
            via a database operation.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              closeSurvey.mutate(
                { id: engagementId },
                {
                  onSuccess: () => {
                    queryClient.invalidateQueries({
                      queryKey: getGetSurveyQueryKey(engagementId),
                    });
                    queryClient.invalidateQueries({
                      queryKey: getGetSurveyAggregatesQueryKey(engagementId),
                    });
                    toast({
                      title: "Survey closed",
                      description: "Dataset is locked for scoring.",
                    });
                  },
                  onError: () =>
                    toast({
                      variant: "destructive",
                      title: "Error",
                      description: "Failed to close survey.",
                    }),
                },
              );
            }}
          >
            Close Survey
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function SurveyBuilder({ engagementId }: { engagementId: string }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: survey, isLoading } = useGetSurvey(engagementId, {
    query: { enabled: !!engagementId, queryKey: getGetSurveyQueryKey(engagementId) },
  });
  const updateSurvey = useUpdateSurvey();
  const [scheduleText, setScheduleText] = useState<string | null>(null);

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (!survey) return <div>No survey configuration found.</div>;

  const groupedQuestions = survey.questions.reduce(
    (acc, q) => {
      if (!acc[q.section]) acc[q.section] = [];
      acc[q.section]!.push(q);
      return acc;
    },
    {} as Record<string, typeof survey.questions>,
  );

  const currentSchedule = (survey.nudgeSchedule ?? [3, 7]).join(", ");

  const saveSchedule = () => {
    const days = (scheduleText ?? currentSchedule)
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 1 && n <= 30);
    updateSurvey.mutate(
      { id: engagementId, data: { nudgeSchedule: days } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getGetSurveyQueryKey(engagementId),
          });
          setScheduleText(null);
          toast({ title: "Nudge schedule updated" });
        },
        onError: () =>
          toast({
            variant: "destructive",
            title: "Error",
            description: "Could not update schedule.",
          }),
      },
    );
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Modules</CardTitle>
          <CardDescription>Active assessment areas</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {survey.modules.map((m) => (
              <Badge key={m} variant="secondary" className="capitalize">
                {m}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reminder schedule</CardTitle>
          <CardDescription>
            Days after invite when a reminder is queued for non-completers (max
            30). Reminders appear in the activity feed for the assessor team
            and downstream notification integrations.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-end gap-3">
          <div className="flex-1 max-w-xs">
            <Label htmlFor="nudge-days">Days (comma-separated)</Label>
            <Input
              id="nudge-days"
              value={scheduleText ?? currentSchedule}
              onChange={(e) => setScheduleText(e.target.value)}
              placeholder="3, 7"
              data-testid="input-nudge-schedule"
              disabled={!!survey.closedAt}
            />
          </div>
          <Button
            onClick={saveSchedule}
            disabled={updateSurvey.isPending || !!survey.closedAt}
            data-testid="button-save-schedule"
          >
            {updateSurvey.isPending ? "Saving..." : "Save schedule"}
          </Button>
        </CardContent>
      </Card>

      {Object.entries(groupedQuestions).map(([section, questions]) => (
        <Card key={section}>
          <CardHeader className="bg-muted/30 pb-3">
            <CardTitle className="text-lg capitalize">
              {section.replace("_", " ")}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Prompt</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Dimension</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {questions.map((q) => (
                  <TableRow key={q.id}>
                    <TableCell className="font-medium max-w-md">
                      {q.prompt}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {q.type.replace("_", " ")}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {q.dimension ? (
                        <Badge className="capitalize">{q.dimension}</Badge>
                      ) : (
                        "-"
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function SurveyResponses({ engagementId }: { engagementId: string }) {
  const { data: aggregates, isLoading } = useGetSurveyAggregates(engagementId, {
    query: {
      enabled: !!engagementId,
      queryKey: getGetSurveyAggregatesQueryKey(engagementId),
    },
  });

  if (isLoading) return <Skeleton className="h-64 w-full" />;

  if (!aggregates || aggregates.totalSent === 0) {
    return (
      <div className="text-center py-16 border rounded bg-muted/10 border-dashed">
        <Users className="h-10 w-10 mx-auto text-muted-foreground mb-4" />
        <h3 className="text-xl font-medium mb-2">No invites sent yet</h3>
        <p className="text-muted-foreground mb-4 max-w-sm mx-auto">
          Distribute the survey to client teams to begin collecting data.
        </p>
      </div>
    );
  }

  const funnel = aggregates.funnel ?? {
    sent: aggregates.totalSent,
    opened: 0,
    started: 0,
    completed: aggregates.totalCompleted,
  };
  const pct = (n: number) =>
    funnel.sent > 0 ? Math.round((n / funnel.sent) * 100) : 0;

  return (
    <div className="space-y-6">
      {/* Completion funnel — sent → opened → started → completed. Each cell
          is an absolute count plus % of sent. No anonymity floor is needed
          at the engagement level. */}
      <div className="grid gap-4 md:grid-cols-4">
        <FunnelCard label="Sent" count={funnel.sent} pct={100} highlight />
        <FunnelCard label="Opened" count={funnel.opened} pct={pct(funnel.opened)} />
        <FunnelCard label="Started" count={funnel.started} pct={pct(funnel.started)} />
        <FunnelCard
          label="Completed"
          count={funnel.completed}
          pct={pct(funnel.completed)}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Per-team completion</CardTitle>
          <CardDescription>
            Breakdown by team. Cells with fewer than 5 respondents are hidden
            to protect anonymity.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Team</TableHead>
                <TableHead>Completed</TableHead>
                <TableHead>Tooling</TableHead>
                <TableHead>Process</TableHead>
                <TableHead>Culture</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {aggregates.byTeam.map((t, i) => (
                <TableRow key={i}>
                  <TableCell className="font-medium">{t.team}</TableCell>
                  <TableCell>
                    {t.suppressed ? (
                      <span className="text-muted-foreground italic text-sm">
                        &lt; 5
                      </span>
                    ) : (
                      t.completedCount
                    )}
                  </TableCell>
                  {t.suppressed ? (
                    <TableCell
                      colSpan={3}
                      className="text-muted-foreground italic text-sm"
                    >
                      Hidden — fewer than 5 respondents (anonymity threshold)
                    </TableCell>
                  ) : (
                    <>
                      <TableCell className="font-mono">
                        {t.dimensionAverages?.tooling?.toFixed(1) || "-"}
                      </TableCell>
                      <TableCell className="font-mono">
                        {t.dimensionAverages?.process?.toFixed(1) || "-"}
                      </TableCell>
                      <TableCell className="font-mono">
                        {t.dimensionAverages?.culture?.toFixed(1) || "-"}
                      </TableCell>
                    </>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {aggregates.byRole && aggregates.byRole.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Demographic mix — by role</CardTitle>
            <CardDescription>
              Counts per invite-time role. Suppressed cells stay below the
              anonymity threshold.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Role</TableHead>
                  <TableHead>Completed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {aggregates.byRole.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium">{r.role}</TableCell>
                    <TableCell>
                      {r.suppressed ? (
                        <span className="text-muted-foreground italic text-sm">
                          Hidden (&lt; 5)
                        </span>
                      ) : (
                        r.completedCount
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function FunnelCard({
  label,
  count,
  pct,
  highlight,
}: {
  label: string;
  count: number;
  pct: number;
  highlight?: boolean;
}) {
  return (
    <Card className={highlight ? "border-primary/40" : ""}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold font-mono">{count}</div>
        <p className="text-xs text-muted-foreground mt-1">{pct}% of sent</p>
      </CardContent>
    </Card>
  );
}

function DistributeDialog({ engagementId }: { engagementId: string }) {
  const [open, setOpen] = useState(false);
  const [csvData, setCsvData] = useState("");
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const previewInvites = usePreviewSurveyInvites();
  const createInvites = useCreateSurveyInvites();

  const reset = () => {
    setCsvData("");
    setPreview(null);
  };

  const runPreview = () => {
    if (!csvData.trim()) return;
    previewInvites.mutate(
      { id: engagementId, data: { csv: csvData } },
      {
        onSuccess: (data) => setPreview(data),
        onError: () =>
          toast({
            variant: "destructive",
            title: "Preview failed",
            description: "Could not parse CSV.",
          }),
      },
    );
  };

  const send = () => {
    const validRows =
      preview?.rows.filter((r) => r.valid && r.team) ?? [];
    if (validRows.length === 0) return;
    const invites = validRows.map((r) => ({
      team: r.team!,
      ...(r.email ? { email: r.email } : {}),
      ...(r.role ? { role: r.role } : {}),
    }));
    createInvites.mutate(
      { id: engagementId, data: { invites } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListSurveyInvitesQueryKey(engagementId),
          });
          queryClient.invalidateQueries({
            queryKey: getGetSurveyAggregatesQueryKey(engagementId),
          });
          toast({
            title: "Invites sent",
            description: `Sent ${invites.length} survey invitations.`,
          });
          reset();
          setOpen(false);
        },
        onError: () =>
          toast({
            variant: "destructive",
            title: "Error",
            description: "Failed to send invites.",
          }),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button className="gap-2" data-testid="button-distribute-survey">
          <Send className="h-4 w-4" /> Distribute Survey
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Distribute Survey</DialogTitle>
          <DialogDescription>
            Paste CSV with columns{" "}
            <code className="text-xs bg-muted px-1 rounded">team,email,role</code>.
            Preview the parsed rows before sending; invalid rows are skipped.
          </DialogDescription>
        </DialogHeader>
        {!preview ? (
          <div className="py-4 space-y-3">
            <Textarea
              placeholder="team,email,role&#10;Engineering,alice@example.com,IC Engineer&#10;Product,bob@example.com,Manager"
              className="min-h-[180px] font-mono text-sm"
              value={csvData}
              onChange={(e) => setCsvData(e.target.value)}
              data-testid="textarea-csv-invites"
            />
            <p className="text-xs text-muted-foreground">
              First row may be a header (<code>team,email,role</code>) — it will
              be detected and skipped.
            </p>
          </div>
        ) : (
          <div className="py-4 space-y-3 max-h-[400px] overflow-auto">
            <div className="flex gap-4 text-sm">
              <Badge
                variant="default"
                className="gap-1"
                data-testid="text-preview-valid"
              >
                <CheckCircle2 className="h-3 w-3" /> {preview.validCount} valid
              </Badge>
              {preview.invalidCount > 0 && (
                <Badge
                  variant="destructive"
                  className="gap-1"
                  data-testid="text-preview-invalid"
                >
                  <AlertCircle className="h-3 w-3" /> {preview.invalidCount}{" "}
                  invalid (will be skipped)
                </Badge>
              )}
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Line</TableHead>
                  <TableHead>Team</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.rows.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-xs">{r.line}</TableCell>
                    <TableCell>{r.team ?? "-"}</TableCell>
                    <TableCell className="text-xs">{r.email ?? "-"}</TableCell>
                    <TableCell className="text-xs">{r.role ?? "-"}</TableCell>
                    <TableCell>
                      {r.valid ? (
                        <Badge variant="secondary" className="text-xs">
                          OK
                        </Badge>
                      ) : (
                        <Badge variant="destructive" className="text-xs">
                          {r.error}
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <DialogFooter>
          {preview ? (
            <>
              <Button variant="outline" onClick={() => setPreview(null)}>
                Back
              </Button>
              <Button
                onClick={send}
                disabled={
                  createInvites.isPending || preview.validCount === 0
                }
                data-testid="button-confirm-send"
              >
                {createInvites.isPending
                  ? "Sending..."
                  : `Send ${preview.validCount} invites`}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={runPreview}
                disabled={previewInvites.isPending || !csvData.trim()}
                data-testid="button-preview-csv"
              >
                {previewInvites.isPending ? "Previewing..." : "Preview"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
