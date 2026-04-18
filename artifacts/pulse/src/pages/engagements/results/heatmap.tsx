import { Badge } from "@/components/ui/badge";
import { Dimension } from "@workspace/api-client-react";

export default function HeatmapView({ engagementId, deliverables }: any) {
  if (!deliverables?.heatmap) return <div className="p-8 text-center text-muted-foreground">No heatmap data available.</div>;

  const stages = [1, 2, 3, 4, 5];
  const stageLabels = ["1. Legacy", "2. AI-Assisted", "3. AI-Enabled", "4. AI-Native", "5. Dark Factory"];

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Agentic Maturity Heatmap</h2>
          <p className="text-muted-foreground">Current state across six core dimensions.</p>
        </div>
        <Badge variant={deliverables.statuses.heatmap === 'locked' ? 'default' : 'outline'} className="uppercase tracking-widest text-xs">
          {deliverables.statuses.heatmap}
        </Badge>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="w-48 p-4 text-left border-b-2 text-lg font-medium text-muted-foreground">Dimension</th>
              {stageLabels.map((label, i) => (
                <th key={i} className="p-4 text-center border-b-2 font-medium text-sm tracking-wider uppercase text-muted-foreground w-1/5">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.values(Dimension).map((dim) => {
              const cellData = deliverables.heatmap.find((c: any) => c.dimension === dim);
              const currentStage = cellData?.currentStage || 0;
              const targetStage = cellData?.targetStage || 0;
              
              return (
                <tr key={dim} className="group">
                  <td className="p-4 border-b text-lg capitalize font-medium">{dim}</td>
                  {stages.map(stage => {
                    const isCurrent = stage === currentStage;
                    const isTarget = stage === targetStage;
                    const isPast = stage < currentStage;
                    const isPath = stage > currentStage && stage <= targetStage;

                    let bgClass = "bg-transparent";
                    if (isCurrent) {
                      bgClass = cellData?.confidence === 'high' ? 'bg-primary text-primary-foreground shadow-inner scale-[1.02] transform transition-transform rounded-md' :
                                cellData?.confidence === 'medium' ? 'bg-primary/80 text-primary-foreground shadow-inner scale-[1.02] transform transition-transform rounded-md' :
                                'bg-primary/60 text-primary-foreground shadow-inner scale-[1.02] transform transition-transform rounded-md';
                    } else if (isTarget) {
                      bgClass = 'bg-accent/20 border-2 border-accent text-accent-foreground border-dashed rounded-md';
                    } else if (isPath) {
                      bgClass = 'bg-accent/5 border border-accent/20 rounded-md';
                    } else if (isPast) {
                      bgClass = 'bg-muted/30 text-muted-foreground rounded-md';
                    }

                    return (
                      <td key={stage} className="p-2 border-b border-transparent">
                        <div className={`h-16 flex items-center justify-center font-mono ${bgClass}`}>
                          {isCurrent && "Current"}
                          {isTarget && "Target"}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
