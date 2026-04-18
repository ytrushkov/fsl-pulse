import { useState } from "react";
import {
  useListDeliverableVersions,
  useFinalizeDeliverable,
  useRevertDeliverable,
  useDraftDeliverables,
  getListDeliverableVersionsQueryKey,
  getGetDeliverablesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { History, Lock, Sparkles, RotateCcw, GitCompare } from "lucide-react";
import { formatRelative } from "@/lib/format";

type DeliverableKey =
  | "heatmap"
  | "gapAnalysis"
  | "actionPlan"
  | "entryPoint"
  | "npv";

interface Props {
  engagementId: string;
  deliverableKey: DeliverableKey;
  status: string | undefined;
  /** When set, hides the "Regenerate" button (e.g., NPV recomputes locally). */
  hideRegenerate?: boolean;
}

/**
 * Per-deliverable toolbar. Surfaces the operations we now expose on the
 * versioning API: regenerate from latest evidence (calls the generic
 * /draft endpoint which honors locked keys), open version history with
 * revert, and finalize the current state. Kept generic so every result
 * page can drop it in with one line.
 */
export function DeliverableToolbar({ engagementId, deliverableKey, status, hideRegenerate }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isLocked = status === "locked";

  const draft = useDraftDeliverables();
  const finalize = useFinalizeDeliverable();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetDeliverablesQueryKey(engagementId) });
    queryClient.invalidateQueries({
      queryKey: getListDeliverableVersionsQueryKey(engagementId, deliverableKey),
    });
  };

  return (
    <div className="flex items-center gap-2">
      <Badge variant={isLocked ? "default" : "outline"} className="uppercase tracking-widest text-xs">
        {status ?? "draft"}
      </Badge>
      {!hideRegenerate && (
        <Button
          variant="outline"
          size="sm"
          disabled={isLocked || draft.isPending}
          onClick={() =>
            draft.mutate(
              { id: engagementId },
              {
                onSuccess: () => {
                  invalidate();
                  toast({ title: "Regenerated", description: "Pulled the latest evidence into the draft." });
                },
                onError: () => toast({ variant: "destructive", title: "Regenerate failed" }),
              },
            )
          }
        >
          <Sparkles className="h-4 w-4 mr-1" /> Regenerate
        </Button>
      )}
      <HistoryDialog engagementId={engagementId} deliverableKey={deliverableKey} onChanged={invalidate} />
      <Button
        variant={isLocked ? "secondary" : "default"}
        size="sm"
        disabled={isLocked || finalize.isPending}
        onClick={() =>
          finalize.mutate(
            { id: engagementId, key: deliverableKey },
            {
              onSuccess: () => {
                invalidate();
                toast({ title: "Finalized", description: "Snapshot recorded and deliverable locked." });
              },
              onError: () => toast({ variant: "destructive", title: "Finalize failed" }),
            },
          )
        }
      >
        <Lock className="h-4 w-4 mr-1" /> {isLocked ? "Locked" : "Finalize"}
      </Button>
    </div>
  );
}

function HistoryDialog({
  engagementId,
  deliverableKey,
  onChanged,
}: {
  engagementId: string;
  deliverableKey: DeliverableKey;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  const { data: versions } = useListDeliverableVersions(engagementId, deliverableKey, {
    query: {
      enabled: open,
      queryKey: getListDeliverableVersionsQueryKey(engagementId, deliverableKey),
    },
  });
  const revert = useRevertDeliverable();
  // Compare picks two version rows and renders their snapshots side-by-side
  // so the assessor can see what changed before deciding to revert. Kept
  // intentionally simple — no inline diff highlight; pretty-printed JSON
  // is enough for the kinds of small, structured deliverables we ship.
  const [compareA, setCompareA] = useState<number | null>(null);
  const [compareB, setCompareB] = useState<number | null>(null);
  const snapshotFor = (n: number | null) =>
    n === null ? null : versions?.find((v) => v.version === n)?.snapshot ?? null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <History className="h-4 w-4 mr-1" /> History
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>
            Each save snapshots the deliverable. Pick two versions to compare side-by-side, or revert to bring an old draft back into play.
          </DialogDescription>
        </DialogHeader>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="max-h-[55vh] overflow-auto divide-y border rounded">
            {!versions?.length ? (
              <div className="py-12 text-center text-muted-foreground text-sm">No saved versions yet.</div>
            ) : (
              versions.map((v) => {
                const role = compareA === v.version ? "A" : compareB === v.version ? "B" : null;
                return (
                  <div key={v.id} className="px-3 py-2 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-mono text-sm font-medium flex items-center gap-2">
                        v{v.version}
                        {role && <Badge variant="secondary" className="text-xs">{role}</Badge>}
                        {v.finalized && <Badge className="text-xs">finalized</Badge>}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {formatRelative(v.createdAt)} {v.authorEmail ? `· ${v.authorEmail}` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Set as compare A"
                        onClick={() => setCompareA(v.version)}
                      >
                        A
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Set as compare B"
                        onClick={() => setCompareB(v.version)}
                      >
                        B
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={revert.isPending}
                        onClick={() =>
                          revert.mutate(
                            { id: engagementId, key: deliverableKey, data: { version: v.version } },
                            {
                              onSuccess: () => {
                                onChanged();
                                setOpen(false);
                                toast({ title: `Reverted to v${v.version}` });
                              },
                              onError: () => toast({ variant: "destructive", title: "Revert failed" }),
                            },
                          )
                        }
                      >
                        <RotateCcw className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <div className="border rounded p-3 max-h-[55vh] overflow-auto bg-muted/20">
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
              <GitCompare className="h-3 w-3" /> Compare
            </div>
            {compareA === null && compareB === null ? (
              <div className="text-xs text-muted-foreground">Pick two versions on the left.</div>
            ) : (
              <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                <CompareColumn label={compareA !== null ? `v${compareA}` : "—"} snapshot={snapshotFor(compareA)} />
                <CompareColumn label={compareB !== null ? `v${compareB}` : "—"} snapshot={snapshotFor(compareB)} />
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CompareColumn({ label, snapshot }: { label: string; snapshot: unknown }) {
  return (
    <div className="border rounded p-2 bg-background overflow-auto">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{label}</div>
      <pre className="whitespace-pre-wrap break-words text-[11px] leading-snug">
        {snapshot === null ? "—" : JSON.stringify(snapshot, null, 2)}
      </pre>
    </div>
  );
}
