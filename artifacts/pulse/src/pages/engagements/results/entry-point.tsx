import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default function EntryPointView({ engagementId, deliverables }: any) {
  if (!deliverables?.entryPoint) return <div className="p-8 text-center text-muted-foreground">No entry point recommendation available.</div>;

  const stages = ['strategy', 'design', 'build', 'ship', 'run'];
  const data = deliverables.entryPoint;

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="flex justify-between items-center mb-12">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Recommended Entry Point</h2>
          <p className="text-muted-foreground">Where to start implementing AI agents in the SDLC.</p>
        </div>
        <Badge variant={deliverables.statuses.entryPoint === 'locked' ? 'default' : 'outline'} className="uppercase tracking-widest text-xs">
          {deliverables.statuses.entryPoint}
        </Badge>
      </div>

      <div className="relative mb-16 px-4">
        <div className="absolute top-1/2 left-0 w-full h-1 bg-muted -z-10 -translate-y-1/2"></div>
        <div className="flex justify-between">
          {stages.map((stage, idx) => {
            const isRecommended = stage === data.recommendedStage;
            return (
              <div key={stage} className="flex flex-col items-center gap-4 relative">
                <div className={`w-12 h-12 rounded-full flex items-center justify-center font-bold text-lg shadow-sm border-2 ${
                  isRecommended 
                    ? 'bg-primary text-primary-foreground border-primary scale-125 ring-4 ring-primary/20' 
                    : 'bg-card text-muted-foreground border-muted'
                }`}>
                  {idx + 1}
                </div>
                <span className={`uppercase tracking-widest text-sm ${isRecommended ? 'font-bold text-primary' : 'text-muted-foreground'}`}>
                  {stage}
                </span>
                {isRecommended && (
                  <div className="absolute -top-10 text-xs font-bold uppercase tracking-wider text-primary bg-primary/10 px-2 py-1 rounded">
                    Start Here
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid md:grid-cols-3 gap-8">
        <div className="md:col-span-2 prose prose-sm dark:prose-invert">
          <h3 className="text-xl font-bold border-b pb-2">Strategic Rationale</h3>
          <p className="text-lg leading-relaxed text-muted-foreground mt-4">
            {data.rationaleMd}
          </p>
        </div>
        
        <div>
          <Card className="bg-muted/20 border-primary/20">
            <CardContent className="pt-6">
              <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-primary"></span>
                Hypr Agents
              </h3>
              <ul className="space-y-4">
                {data.hyprAgents?.map((agent: any, i: number) => (
                  <li key={i} className="text-sm">
                    <span className="font-bold text-foreground block mb-1">{agent.name}</span>
                    <span className="text-muted-foreground leading-snug">{agent.relevance}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
