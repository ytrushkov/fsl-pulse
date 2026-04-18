import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";

export default function GapAnalysisView({ engagementId, deliverables }: any) {
  if (!deliverables?.gapAnalysis?.length) return <div className="p-8 text-center text-muted-foreground">No gap analysis data available.</div>;

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Gap Analysis</h2>
          <p className="text-muted-foreground">Narrative findings and cited evidence.</p>
        </div>
        <Badge variant={deliverables.statuses.gapAnalysis === 'locked' ? 'default' : 'outline'} className="uppercase tracking-widest text-xs">
          {deliverables.statuses.gapAnalysis}
        </Badge>
      </div>

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
              <div className="prose prose-sm dark:prose-invert max-w-none mb-6 text-base leading-relaxed">
                {/* Normally we'd render Markdown here, assuming plain text for now */}
                {item.narrativeMd.split('\n').map((p: string, i: number) => <p key={i}>{p}</p>)}
              </div>
              
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
