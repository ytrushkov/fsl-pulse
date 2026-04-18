import { useState } from "react";
import {
  useListConnectorRuns,
  getListConnectorRunsQueryKey,
  type ConnectorRun,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronLeft, ChevronRight, AlertCircle } from "lucide-react";
import { formatRelative } from "@/lib/format";

const PAGE_SIZE = 25;

interface RunHistoryDialogProps {
  connectorId: string | null;
  connectorLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RunHistoryDialog({
  connectorId,
  connectorLabel,
  open,
  onOpenChange,
}: RunHistoryDialogProps) {
  const [page, setPage] = useState(0);
  // Reset to first page each time the dialog opens for a different connector
  // so the assessor never lands on a stale page from a prior connector.
  const offset = page * PAGE_SIZE;

  const { data, isLoading } = useListConnectorRuns(
    connectorId ?? "",
    { limit: PAGE_SIZE, offset },
    {
      query: {
        enabled: Boolean(connectorId && open),
        queryKey: getListConnectorRunsQueryKey(connectorId ?? "", {
          limit: PAGE_SIZE,
          offset,
        }),
      },
    },
  );

  const runs: ConnectorRun[] = data ?? [];
  // The API returns at most PAGE_SIZE rows; if we got a full page we can
  // assume there's at least one more page. (No total count is returned to
  // keep the endpoint cheap.)
  const hasNext = runs.length === PAGE_SIZE;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setPage(0);
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Run history — {connectorLabel}</DialogTitle>
          <DialogDescription>
            Each run records when it started, how it finished, how many records
            were collected, and any error message.
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : runs.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No runs yet. Trigger one with the Run button on this connector.
          </p>
        ) : (
          <div className="space-y-2">
            {runs.map((run) => (
              <div
                key={run.id}
                className="border rounded-md p-3 space-y-1"
                data-testid={`run-row-${run.id}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={
                        run.status === "success"
                          ? "default"
                          : run.status === "failed"
                            ? "destructive"
                            : "secondary"
                      }
                      className="capitalize"
                    >
                      {run.status}
                    </Badge>
                    <span className="text-sm font-medium">
                      {run.recordsCollected ?? 0} records
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {formatRelative(run.startedAt)}
                  </span>
                </div>
                {run.error ? (
                  <div className="flex items-start gap-1.5 text-xs text-destructive">
                    <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span className="break-words">{run.error}</span>
                  </div>
                ) : null}
                {run.finishedAt ? (
                  <p className="text-xs text-muted-foreground">
                    Finished {formatRelative(run.finishedAt)}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between pt-2 border-t">
          <span className="text-xs text-muted-foreground">
            Page {page + 1}
            {runs.length > 0
              ? ` · showing ${offset + 1}–${offset + runs.length}`
              : ""}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!hasNext}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
