import { useEffect, useState } from "react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useUpdateDeliverables, getGetDeliverablesQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { DeliverableToolbar } from "@/components/deliverables/deliverable-toolbar";

export default function GapAnalysisView({ engagementId, deliverables }: any) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const update = useUpdateDeliverables();
  // Local edit buffer keyed by dimension so a user can revise narratives in
  // place without immediately persisting on every keystroke.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  useEffect(() => {
    if (deliverables?.gapAnalysis) {
      setDrafts(Object.fromEntries(deliverables.gapAnalysis.map((g: any) => [g.dimension, g.narrativeMd])));
    }
  }, [deliverables?.gapAnalysis]);

  if (!deliverables?.gapAnalysis?.length) return <div className="p-8 text-center text-muted-foreground">No gap analysis data available.</div>;

  const isLocked = deliverables.statuses.gapAnalysis === "locked";
  const dirty = deliverables.gapAnalysis.some((g: any) => drafts[g.dimension] !== g.narrativeMd);

  const save = () => {
    update.mutate(
      {
        id: engagementId,
        data: {
          gapAnalysis: deliverables.gapAnalysis.map((g: any) => ({
            ...g,
            narrativeMd: drafts[g.dimension] ?? g.narrativeMd,
          })),
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetDeliverablesQueryKey(engagementId) });
          toast({ title: "Saved", description: "Narratives updated." });
        },
        onError: () => toast({ variant: "destructive", title: "Save failed" }),
      },
    );
  };

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Gap Analysis</h2>
          <p className="text-muted-foreground">Narrative findings and cited evidence.</p>
        </div>
        <DeliverableToolbar engagementId={engagementId} deliverableKey="gapAnalysis" status={deliverables.statuses.gapAnalysis} />
      </div>

      {dirty && !isLocked && (
        <div className="mb-4 flex items-center justify-end gap-2">
          <Button size="sm" onClick={save} disabled={update.isPending}>
            {update.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      )}

      <Accordion type="multiple" defaultValue={deliverables.gapAnalysis.map((g: any) => g.dimension)} className="w-full">
        {deliverables.gapAnalysis.map((item: any) => (
          <AccordionItem key={item.dimension} value={item.dimension} className="border bg-card mb-4 rounded-lg overflow-hidden px-2 shadow-sm">
            <AccordionTrigger className="hover:no-underline px-4 py-4">
              <div className="flex items-center justify-between w-full pr-4">
                <div className="flex items-center gap-4">
                  <span className="text-lg capitalize font-bold">{item.dimension}</span>
                </div>
                <div className="flex items-center gap-2 text-sm font-mono bg-muted px-3 py-1 rounded-full">
                  <span>Stage {item.currentStage}</span>
                  <span className="text-muted-foreground">→</span>
                  <span>Stage {item.targetStage}</span>
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="px-4 pb-6 pt-2">
              {isLocked ? (
                <div className="prose prose-sm dark:prose-invert max-w-none mb-6 text-base leading-relaxed">
                  {(drafts[item.dimension] ?? item.narrativeMd).split('\n').map((p: string, i: number) => <p key={i}>{p}</p>)}
                </div>
              ) : (
                <Textarea
                  value={drafts[item.dimension] ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [item.dimension]: e.target.value }))}
                  rows={8}
                  className="font-mono text-sm mb-6"
                />
              )}
              
              <div className="bg-muted/30 p-4 rounded-md border border-muted">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Supporting Evidence</h4>
                <div className="flex flex-wrap gap-2">
                  {item.evidenceIds?.length ? (
                    item.evidenceIds.map((id: string) => (
                      <Badge key={id} variant="secondary" className="font-mono text-xs">EV-{id.substring(0, 6)}</Badge>
                    ))
                  ) : (
                    <span className="text-sm text-destructive flex items-center">
                      <span className="h-2 w-2 rounded-full bg-destructive mr-2"></span>
                      Needs evidence — cannot lock
                    </span>
                  )}
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  );
}
