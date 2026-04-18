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
import { History, Lock, Sparkles, RotateCcw } from "lucide-react";
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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <History className="h-4 w-4 mr-1" /> History
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>
            Each save snapshots the deliverable. Revert to bring an old draft back into play.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto divide-y">
          {!versions?.length ? (
            <div className="py-12 text-center text-muted-foreground text-sm">No saved versions yet.</div>
          ) : (
            versions.map((v) => (
              <div key={v.id} className="py-3 flex items-center justify-between gap-4">
                <div>
                  <div className="font-mono text-sm font-medium">v{v.version}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatRelative(v.createdAt)} {v.authorEmail ? `· ${v.authorEmail}` : ""}
                    {v.finalized ? " · finalized" : ""}
                  </div>
                </div>
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
                  <RotateCcw className="h-4 w-4 mr-1" /> Revert
                </Button>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
