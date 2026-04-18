import { useEffect, useState } from "react";
import {
  Dimension,
  useUpdateDeliverables,
  getGetDeliverablesQueryKey,
  type Deliverables,
  type HeatmapCell,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { DeliverableToolbar } from "@/components/deliverables/deliverable-toolbar";

interface ViewProps {
  engagementId: string;
  deliverables: Deliverables;
}

export default function HeatmapView({ engagementId, deliverables }: ViewProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const update = useUpdateDeliverables();
  // Local edit buffer for per-cell notes; keyed by dimension so a single
  // save mutation can persist all dirty cells together.
  const [notes, setNotes] = useState<Record<string, string>>({});
  useEffect(() => {
    if (deliverables?.heatmap) {
      setNotes(
        Object.fromEntries(deliverables.heatmap.map((c) => [c.dimension, c.notes ?? ""])),
      );
    }
  }, [deliverables?.heatmap]);

  if (!deliverables?.heatmap)
    return <div className="p-8 text-center text-muted-foreground">No heatmap data available.</div>;

  const stages = [1, 2, 3, 4, 5];
  const stageLabels = ["1. Legacy", "2. AI-Assisted", "3. AI-Enabled", "4. AI-Native", "5. Dark Factory"];
  const isLocked = deliverables.statuses.heatmap === "locked";
  const dirty = deliverables.heatmap.some(
    (c) => (notes[c.dimension] ?? "") !== (c.notes ?? ""),
  );

  const save = () => {
    update.mutate(
      {
        id: engagementId,
        data: {
          heatmap: deliverables.heatmap.map((c): HeatmapCell => ({
            ...c,
            notes: notes[c.dimension] ?? c.notes ?? "",
          })),
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetDeliverablesQueryKey(engagementId) });
          toast({ title: "Saved", description: "Heatmap notes updated." });
        },
        onError: () => toast({ variant: "destructive", title: "Save failed" }),
      },
    );
  };

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Agentic Maturity Heatmap</h2>
          <p className="text-muted-foreground">Current state across six core dimensions.</p>
        </div>
        <DeliverableToolbar
          engagementId={engagementId}
          deliverableKey="heatmap"
          status={deliverables.statuses.heatmap}
        />
      </div>

      {dirty && !isLocked && (
        <div className="mb-4 flex items-center justify-end gap-2">
          <Button size="sm" onClick={save} disabled={update.isPending}>
            {update.isPending ? "Saving…" : "Save notes"}
          </Button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="w-48 p-4 text-left border-b-2 text-lg font-medium text-muted-foreground">
                Dimension
              </th>
              {stageLabels.map((label, i) => (
                <th
                  key={i}
                  className="p-4 text-center border-b-2 font-medium text-sm tracking-wider uppercase text-muted-foreground w-1/6"
                >
                  {label}
                </th>
              ))}
              <th className="w-72 p-4 text-left border-b-2 font-medium text-sm tracking-wider uppercase text-muted-foreground">
                Notes
              </th>
            </tr>
          </thead>
          <tbody>
            {Object.values(Dimension).map((dim) => {
              const cellData = deliverables.heatmap.find((c) => c.dimension === dim);
              const currentStage = cellData?.currentStage || 0;
              const targetStage = cellData?.targetStage || 0;

              return (
                <tr key={dim} className="group">
                  <td className="p-4 border-b text-lg capitalize font-medium align-top">{dim}</td>
                  {stages.map((stage) => {
                    const isCurrent = stage === currentStage;
                    const isTarget = stage === targetStage;
                    const isPast = stage < currentStage;
                    const isPath = stage > currentStage && stage <= targetStage;

                    let bgClass = "bg-transparent";
                    if (isCurrent) {
                      bgClass =
                        cellData?.confidence === "high"
                          ? "bg-primary text-primary-foreground shadow-inner scale-[1.02] transform transition-transform rounded-md"
                          : cellData?.confidence === "medium"
                            ? "bg-primary/80 text-primary-foreground shadow-inner scale-[1.02] transform transition-transform rounded-md"
                            : "bg-primary/60 text-primary-foreground shadow-inner scale-[1.02] transform transition-transform rounded-md";
                    } else if (isTarget) {
                      bgClass = "bg-accent/20 border-2 border-accent text-accent-foreground border-dashed rounded-md";
                    } else if (isPath) {
                      bgClass = "bg-accent/5 border border-accent/20 rounded-md";
                    } else if (isPast) {
                      bgClass = "bg-muted/30 text-muted-foreground rounded-md";
                    }

                    return (
                      <td key={stage} className="p-2 border-b border-transparent align-top">
                        <div className={`h-16 flex items-center justify-center font-mono ${bgClass}`}>
                          {isCurrent && "Current"}
                          {isTarget && "Target"}
                        </div>
                      </td>
                    );
                  })}
                  <td className="p-2 border-b align-top">
                    {isLocked ? (
                      <p className="text-xs text-muted-foreground whitespace-pre-wrap min-h-[4rem]">
                        {cellData?.notes ?? ""}
                      </p>
                    ) : (
                      <Textarea
                        value={notes[dim] ?? ""}
                        onChange={(e) =>
                          setNotes((n) => ({ ...n, [dim]: e.target.value }))
                        }
                        rows={3}
                        placeholder="Assessor notes…"
                        className="text-xs"
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
