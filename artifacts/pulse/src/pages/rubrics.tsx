import { useMemo, useState } from "react";
import {
  useListRubrics,
  useCreateRubricDraft,
  useUpdateRubricDraft,
  usePublishRubric,
  useDeleteRubricDraft,
  useListEngagements,
  usePreviewScoring,
  getListRubricsQueryKey,
  type RubricVersion,
  type RubricBody,
  type Scoring,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { formatRelative } from "@/lib/format";
import {
  BookCheck,
  Plus,
  Save,
  Send,
  Trash2,
  Eye,
  AlertTriangle,
} from "lucide-react";

const DIMENSIONS = [
  "tooling",
  "measurement",
  "process",
  "people",
  "governance",
  "culture",
] as const;

export default function RubricsPage() {
  const { data: rubrics, isLoading } = useListRubrics();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const sorted = useMemo(
    () =>
      [...(rubrics ?? [])].sort((a, b) => {
        // Drafts first, then newest published.
        if (a.status !== b.status) return a.status === "draft" ? -1 : 1;
        return b.createdAt.localeCompare(a.createdAt);
      }),
    [rubrics],
  );

  const selected = useMemo(
    () => sorted.find((r) => r.id === selectedId) ?? sorted[0] ?? null,
    [sorted, selectedId],
  );

  return (
    <AppLayout>
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <BookCheck className="h-7 w-7 text-primary" />
            Scoring Rubrics
          </h1>
          <p className="text-muted-foreground mt-1">
            Versioned 6-dimension × 5-stage maturity rubrics. Drafts can be
            previewed against any engagement before publishing.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!selected}
            onClick={() => setPreviewOpen(true)}
            className="gap-2"
          >
            <Eye className="h-4 w-4" /> Preview against engagement
          </Button>
          <Button onClick={() => setCreateOpen(true)} className="gap-2">
            <Plus className="h-4 w-4" /> New draft
          </Button>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-[280px_1fr]">
        <Card className="h-fit">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
              Versions
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {isLoading ? (
              <>
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </>
            ) : sorted.length === 0 ? (
              <p className="text-sm text-muted-foreground">No rubrics yet.</p>
            ) : (
              sorted.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  className={`w-full text-left rounded-md px-3 py-2 transition-colors hover-elevate ${
                    selected?.id === r.id
                      ? "bg-primary/15 ring-1 ring-inset ring-primary/40"
                      : ""
                  }`}
                  data-testid={`rubric-list-item-${r.version}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium font-mono text-sm">
                      v{r.version}
                    </span>
                    <Badge
                      variant={r.status === "published" ? "default" : "outline"}
                      className={
                        r.status === "draft"
                          ? "bg-yellow-500/10 text-yellow-700 border-yellow-200"
                          : ""
                      }
                    >
                      {r.status}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {r.publishedAt
                      ? `Published ${formatRelative(r.publishedAt)}`
                      : `Created ${formatRelative(r.createdAt)}`}
                  </div>
                </button>
              ))
            )}
          </CardContent>
        </Card>

        {selected ? (
          <RubricEditor key={selected.id} rubric={selected} />
        ) : (
          <Card>
            <CardContent className="py-16 text-center text-muted-foreground">
              Select a rubric on the left or create a new draft.
            </CardContent>
          </Card>
        )}
      </div>

      <CreateDraftDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        rubrics={sorted}
        onCreated={(id) => setSelectedId(id)}
      />

      {selected && (
        <PreviewDialog
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          rubric={selected}
        />
      )}
    </AppLayout>
  );
}

function RubricEditor({ rubric }: { rubric: RubricVersion }) {
  const [body, setBody] = useState<RubricBody>(rubric.body);
  const [version, setVersion] = useState(rubric.version);
  const [notes, setNotes] = useState(rubric.notes ?? "");
  const isDraft = rubric.status === "draft";

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useUpdateRubricDraft();
  const publish = usePublishRubric();
  const del = useDeleteRubricDraft();

  function handleSave() {
    update.mutate(
      { id: rubric.id, data: { version, notes, body } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListRubricsQueryKey() });
          toast({ title: "Draft saved" });
        },
        onError: (err) => {
          toast({
            variant: "destructive",
            title: "Save failed",
            description: err instanceof Error ? err.message : "",
          });
        },
      },
    );
  }

  function handlePublish() {
    if (
      !confirm(
        `Publish rubric v${version}? Once published it becomes the default for new scoring runs and the draft is locked.`,
      )
    )
      return;
    publish.mutate(
      { id: rubric.id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListRubricsQueryKey() });
          toast({ title: "Rubric published" });
        },
        onError: (err) => {
          toast({
            variant: "destructive",
            title: "Publish failed",
            description: err instanceof Error ? err.message : "",
          });
        },
      },
    );
  }

  function handleDelete() {
    if (!confirm("Delete this draft? This cannot be undone.")) return;
    del.mutate(
      { id: rubric.id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListRubricsQueryKey() });
          toast({ title: "Draft deleted" });
        },
        onError: (err) => {
          toast({
            variant: "destructive",
            title: "Delete failed",
            description: err instanceof Error ? err.message : "",
          });
        },
      },
    );
  }

  function patchDimension(
    dimension: string,
    fn: (d: RubricBody["dimensions"][number]) => RubricBody["dimensions"][number],
  ) {
    setBody((prev) => ({
      ...prev,
      dimensions: prev.dimensions.map((d) =>
        d.dimension === dimension ? fn(d) : d,
      ),
    }));
  }

  function patchWeight(dimension: string, w: number) {
    setBody((prev) => ({
      ...prev,
      dimensionWeights: { ...(prev.dimensionWeights ?? {}), [dimension]: w },
    }));
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle>Rubric metadata</CardTitle>
            <div className="flex gap-2">
              {isDraft ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleDelete}
                    disabled={del.isPending}
                    className="gap-1.5 text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleSave}
                    disabled={update.isPending}
                    className="gap-1.5"
                  >
                    <Save className="h-3.5 w-3.5" />{" "}
                    {update.isPending ? "Saving…" : "Save"}
                  </Button>
                  <Button
                    size="sm"
                    onClick={handlePublish}
                    disabled={publish.isPending}
                    className="gap-1.5"
                  >
                    <Send className="h-3.5 w-3.5" />{" "}
                    {publish.isPending ? "Publishing…" : "Publish"}
                  </Button>
                </>
              ) : (
                <Badge variant="outline">Read-only — published</Badge>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Version</Label>
            <Input
              value={version}
              disabled={!isDraft}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="1.1.0"
            />
          </div>
          <div className="space-y-2">
            <Label>Notes</Label>
            <Input
              value={notes}
              disabled={!isDraft}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What changed in this version?"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Dimension weights</CardTitle>
          <p className="text-sm text-muted-foreground">
            Weighting controls how each dimension contributes to the overall
            score. Default is 1.0 across the board.
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {DIMENSIONS.map((dim) => (
              <div key={dim} className="space-y-1">
                <Label className="capitalize text-xs">{dim}</Label>
                <Input
                  type="number"
                  step="0.1"
                  min="0"
                  disabled={!isDraft}
                  value={body.dimensionWeights?.[dim] ?? 1}
                  onChange={(e) =>
                    patchWeight(dim, parseFloat(e.target.value) || 0)
                  }
                />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4">
        {body.dimensions.map((dim) => (
          <Card key={dim.dimension}>
            <CardHeader className="pb-3">
              <CardTitle className="capitalize text-lg">
                {dim.dimension}
              </CardTitle>
              <Textarea
                value={dim.description ?? ""}
                disabled={!isDraft}
                placeholder="Dimension description"
                onChange={(e) =>
                  patchDimension(dim.dimension, (d) => ({
                    ...d,
                    description: e.target.value,
                  }))
                }
                className="mt-2 min-h-[60px]"
              />
            </CardHeader>
            <CardContent className="space-y-3">
              {dim.stages.map((stage) => (
                <div
                  key={stage.stage}
                  className="rounded-md border bg-muted/20 p-3"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant="secondary">Stage {stage.stage}</Badge>
                  </div>
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                    Summary
                  </Label>
                  <Textarea
                    value={stage.summary}
                    disabled={!isDraft}
                    onChange={(e) =>
                      patchDimension(dim.dimension, (d) => ({
                        ...d,
                        stages: d.stages.map((s) =>
                          s.stage === stage.stage
                            ? { ...s, summary: e.target.value }
                            : s,
                        ),
                      }))
                    }
                    className="mt-1 min-h-[60px]"
                  />
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground mt-3 block">
                    Indicators (one per line)
                  </Label>
                  <Textarea
                    value={(stage.indicators ?? []).join("\n")}
                    disabled={!isDraft}
                    onChange={(e) =>
                      patchDimension(dim.dimension, (d) => ({
                        ...d,
                        stages: d.stages.map((s) =>
                          s.stage === stage.stage
                            ? {
                                ...s,
                                indicators: e.target.value
                                  .split("\n")
                                  .map((x) => x.trim())
                                  .filter(Boolean),
                              }
                            : s,
                        ),
                      }))
                    }
                    className="mt-1 min-h-[80px] font-mono text-xs"
                  />
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function CreateDraftDialog({
  open,
  onOpenChange,
  rubrics,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  rubrics: RubricVersion[];
  onCreated: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const create = useCreateRubricDraft();
  const [version, setVersion] = useState("");
  const [notes, setNotes] = useState("");
  const latestPublished = rubrics.find((r) => r.status === "published");
  const [cloneFromId, setCloneFromId] = useState<string | undefined>(
    latestPublished?.id,
  );

  function handleCreate() {
    if (!version.trim()) {
      toast({ variant: "destructive", title: "Version required" });
      return;
    }
    create.mutate(
      {
        data: {
          version: version.trim(),
          notes,
          cloneFromId,
        },
      },
      {
        onSuccess: (row) => {
          queryClient.invalidateQueries({ queryKey: getListRubricsQueryKey() });
          toast({ title: "Draft created" });
          onCreated(row.id);
          onOpenChange(false);
          setVersion("");
          setNotes("");
        },
        onError: (err) => {
          toast({
            variant: "destructive",
            title: "Create failed",
            description: err instanceof Error ? err.message : "",
          });
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New rubric draft</DialogTitle>
          <DialogDescription>
            Drafts are editable and can be previewed against any engagement
            before publishing.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label>Version</Label>
            <Input
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="1.1.0"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Summary of changes…"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Clone from</Label>
            <Select
              value={cloneFromId ?? "__none__"}
              onValueChange={(v) =>
                setCloneFromId(v === "__none__" ? undefined : v)
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">
                  Start from built-in defaults
                </SelectItem>
                {rubrics.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    v{r.version} ({r.status})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewDialog({
  open,
  onOpenChange,
  rubric,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  rubric: RubricVersion;
}) {
  const { data: engagements } = useListEngagements();
  const [engagementId, setEngagementId] = useState<string>("");
  const preview = usePreviewScoring();
  const [result, setResult] = useState<{
    preview: Scoring;
    current?: Scoring | null;
  } | null>(null);
  const { toast } = useToast();

  function handleRun() {
    if (!engagementId) {
      toast({ variant: "destructive", title: "Pick an engagement" });
      return;
    }
    preview.mutate(
      { id: engagementId, data: { rubricVersionId: rubric.id } },
      {
        onSuccess: (r) => setResult(r),
        onError: (err) =>
          toast({
            variant: "destructive",
            title: "Preview failed",
            description: err instanceof Error ? err.message : "",
          }),
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) setResult(null);
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            Preview rubric v{rubric.version} against engagement
          </DialogTitle>
          <DialogDescription>
            Recomputes scoring under this rubric without persisting. Compare
            against the engagement's current pinned rubric.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2 items-end py-2">
          <div className="flex-1 space-y-1.5">
            <Label>Engagement</Label>
            <Select value={engagementId} onValueChange={setEngagementId}>
              <SelectTrigger>
                <SelectValue placeholder="Select engagement" />
              </SelectTrigger>
              <SelectContent>
                {(engagements ?? []).map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.clientName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={handleRun} disabled={preview.isPending}>
            {preview.isPending ? "Running…" : "Run preview"}
          </Button>
        </div>

        {result && (
          <DeltaTable preview={result.preview} current={result.current ?? null} />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function DeltaTable({
  preview,
  current,
}: {
  preview: Scoring;
  current: Scoring | null;
}) {
  const currentByDim = new Map(
    (current?.byDimension ?? []).map((d) => [d.dimension, d]),
  );
  const currentOverall = current?.overall.score;
  const previewOverall = preview.overall.score;
  const overallDelta =
    currentOverall != null ? previewOverall - currentOverall : null;

  return (
    <div className="rounded-md border">
      <div className="grid grid-cols-4 gap-2 px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground bg-muted/40">
        <span>Dimension</span>
        <span className="text-right">Current</span>
        <span className="text-right">Preview</span>
        <span className="text-right">Δ</span>
      </div>
      {preview.byDimension.map((d) => {
        const cur = currentByDim.get(d.dimension);
        const delta = cur ? d.score - cur.score : null;
        return (
          <div
            key={d.dimension}
            className="grid grid-cols-4 gap-2 px-3 py-2 border-t text-sm items-center"
          >
            <span className="capitalize font-medium">{d.dimension}</span>
            <span className="text-right font-mono">
              {cur ? cur.score.toFixed(2) : "—"}
            </span>
            <span className="text-right font-mono">{d.score.toFixed(2)}</span>
            <span className="text-right font-mono">
              {delta == null ? (
                "—"
              ) : (
                <DeltaBadge value={delta} />
              )}
            </span>
          </div>
        );
      })}
      <div className="grid grid-cols-4 gap-2 px-3 py-2 border-t bg-primary/5 text-sm font-semibold items-center">
        <span>Overall</span>
        <span className="text-right font-mono">
          {currentOverall != null ? currentOverall.toFixed(2) : "—"}
        </span>
        <span className="text-right font-mono">{previewOverall.toFixed(2)}</span>
        <span className="text-right font-mono">
          {overallDelta == null ? "—" : <DeltaBadge value={overallDelta} />}
        </span>
      </div>
      {!current && (
        <div className="px-3 py-2 text-xs text-muted-foreground bg-yellow-500/5 border-t flex items-center gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5" />
          This engagement has no scoring yet — deltas can't be computed.
        </div>
      )}
    </div>
  );
}

function DeltaBadge({ value }: { value: number }) {
  const fixed = value.toFixed(2);
  if (Math.abs(value) < 0.005) return <span className="text-muted-foreground">0.00</span>;
  return (
    <span className={value > 0 ? "text-green-600" : "text-red-600"}>
      {value > 0 ? "+" : ""}
      {fixed}
    </span>
  );
}
