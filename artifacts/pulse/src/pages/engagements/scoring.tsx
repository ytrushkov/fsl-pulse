import { useState } from "react";
import { useParams } from "wouter";
import { useGetScoring, useComputeScoring, useOverrideDimensionScore, getGetScoringQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Calculator, Target, Info, AlertTriangle, FileText, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatRelative } from "@/lib/format";

export default function ScoringView() {
  const params = useParams();
  const id = params.id as string;
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: scoring, isLoading } = useGetScoring(id, {
    query: { enabled: !!id }
  });

  const computeScoring = useComputeScoring();

  const handleCompute = () => {
    computeScoring.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetScoringQueryKey(id) });
          toast({ title: "Scoring computed", description: "Updated maturity scores based on latest evidence." });
        },
        onError: () => {
          toast({ variant: "destructive", title: "Error", description: "Failed to compute scoring." });
        }
      }
    );
  };

  const getConfidenceColor = (confidence: string) => {
    switch (confidence) {
      case 'high': return 'bg-green-500/10 text-green-700 border-green-200';
      case 'medium': return 'bg-yellow-500/10 text-yellow-700 border-yellow-200';
      case 'low': return 'bg-red-500/10 text-red-700 border-red-200';
      default: return 'bg-muted text-muted-foreground';
    }
  };

  return (
    <AppLayout engagementId={id}>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-serif font-bold tracking-tight">Scoring Dashboard</h1>
          <p className="text-muted-foreground mt-1 flex items-center gap-2">
            Maturity evaluation across 6 key dimensions. 
            {scoring?.computedAt && (
              <span className="text-xs border rounded px-1.5 py-0.5 bg-muted/50">
                Last computed {formatRelative(scoring.computedAt)}
              </span>
            )}
          </p>
        </div>
        <Button onClick={handleCompute} disabled={computeScoring.isPending} className="gap-2">
          <Calculator className="h-4 w-4" />
          {computeScoring.isPending ? "Computing..." : "Score all"}
        </Button>
      </div>

      <div className="mb-8 p-6 bg-primary text-primary-foreground rounded-lg shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-serif mb-1 text-primary-foreground/80">Overall Agentic Maturity</h2>
            <div className="flex items-end gap-3">
              {isLoading ? (
                <Skeleton className="h-10 w-32 bg-primary-foreground/20" />
              ) : scoring?.overall ? (
                <>
                  <span className="text-4xl font-bold font-mono leading-none">
                    {scoring.overall.score.toFixed(1)}
                  </span>
                  <span className="text-xl font-medium mb-1">/ 5.0</span>
                </>
              ) : (
                <span className="text-2xl font-bold">Unscored</span>
              )}
            </div>
          </div>
          {scoring?.overall && (
            <div className="text-right">
              <div className="text-sm font-medium uppercase tracking-wider text-primary-foreground/80 mb-1">Target Stage</div>
              <div className="text-2xl font-serif">Stage {Math.ceil(scoring.overall.score)}</div>
            </div>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {[...Array(6)].map((_, i) => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <Skeleton className="h-6 w-1/2 mb-2" />
                <Skeleton className="h-4 w-1/3" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-16 w-full mb-2" />
                <Skeleton className="h-4 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : !scoring?.byDimension ? (
        <div className="text-center py-20 border rounded bg-muted/10 border-dashed">
          <Target className="h-10 w-10 mx-auto text-muted-foreground mb-4" />
          <h3 className="text-xl font-serif font-semibold mb-2">No Scores Computed</h3>
          <p className="text-muted-foreground mb-6 max-w-md mx-auto">
            Collect evidence via connectors, surveys, and interviews, then run the scoring algorithm to generate maturity scores.
          </p>
          <Button onClick={handleCompute} disabled={computeScoring.isPending} size="lg">
            <Calculator className="mr-2 h-5 w-5" />
            Compute Scores Now
          </Button>
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {scoring.byDimension.map((dim) => (
            <OverrideDialog 
              key={dim.dimension} 
              engagementId={id} 
              dimension={dim} 
              trigger={
                <Card className="cursor-pointer hover-elevate hover:border-primary/50 transition-all h-full flex flex-col">
                  <CardHeader className="pb-2">
                    <div className="flex justify-between items-start">
                      <CardTitle className="text-lg font-serif capitalize">
                        {dim.dimension}
                      </CardTitle>
                      <Badge variant="outline" className={getConfidenceColor(dim.confidence)}>
                        {dim.confidence} conf
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="flex-1">
                    <div className="flex items-end gap-2 mb-4">
                      <span className="text-3xl font-bold font-mono">{dim.score.toFixed(1)}</span>
                      <span className="text-sm text-muted-foreground font-medium mb-1">Stage {dim.stage}</span>
                    </div>
                    <p className="text-sm text-muted-foreground line-clamp-3" title={dim.rationale}>
                      {dim.rationale}
                    </p>
                    {dim.overrideJustification && (
                      <div className="mt-4 p-2 bg-yellow-500/10 border border-yellow-500/20 rounded text-xs text-yellow-800 dark:text-yellow-400 flex gap-2 items-start">
                        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                        <span>Manually overridden: {dim.overrideJustification}</span>
                      </div>
                    )}
                  </CardContent>
                  <CardFooter className="pt-2 border-t text-xs text-muted-foreground bg-muted/5 flex justify-between">
                    <span className="flex items-center gap-1">
                      <FileText className="h-3 w-3" />
                      {dim.evidenceIds?.length || 0} signals
                    </span>
                    <span className="text-primary font-medium group-hover:underline">Review & Override</span>
                  </CardFooter>
                </Card>
              } 
            />
          ))}
        </div>
      )}
    </AppLayout>
  );
}

function OverrideDialog({ engagementId, dimension, trigger }: { engagementId: string, dimension: any, trigger: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<number>(dimension.stage);
  const [score, setScore] = useState<number | "">(dimension.score);
  const [justification, setJustification] = useState(dimension.overrideJustification || "");
  
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const overrideScore = useOverrideDimensionScore();

  const handleSave = () => {
    if (!justification) {
      toast({ variant: "destructive", title: "Error", description: "Justification is required for manual overrides." });
      return;
    }

    overrideScore.mutate(
      { 
        id: engagementId, 
        data: { 
          dimension: dimension.dimension, 
          stage: Number(stage), 
          score: score === "" ? undefined : Number(score),
          justification 
        } 
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetScoringQueryKey(engagementId) });
          toast({ title: "Score overridden", description: `Successfully updated ${dimension.dimension} score.` });
          setOpen(false);
        },
        onError: () => {
          toast({ variant: "destructive", title: "Error", description: "Failed to override score." });
        }
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger}
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-2xl font-serif capitalize">
            {dimension.dimension} Details
          </DialogTitle>
        </DialogHeader>
        
        <div className="grid gap-6 py-4">
          <div className="bg-muted p-4 rounded-md">
            <h4 className="font-semibold text-sm mb-2 uppercase tracking-wider">AI Rationale</h4>
            <p className="text-sm">{dimension.rationale}</p>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-3 uppercase tracking-wider">Signals Breakdown</h4>
            <div className="grid grid-cols-4 gap-2">
              {['system', 'survey', 'interview', 'artifact'].map((source) => (
                <div key={source} className="border rounded p-3 flex flex-col items-center justify-center text-center bg-card">
                  <span className="text-xs text-muted-foreground capitalize mb-1">{source}</span>
                  <span className="font-mono font-medium text-lg">
                    {dimension.signalsBySource?.[source as keyof typeof dimension.signalsBySource]?.toFixed(1) || '-'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="border-t pt-6">
            <h4 className="font-serif text-lg font-bold mb-4 flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-yellow-500" />
              Manual Override
            </h4>
            <div className="grid gap-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Stage (1-5)</Label>
                  <Input 
                    type="number" 
                    min={1} max={5} 
                    value={stage} 
                    onChange={(e) => setStage(parseInt(e.target.value))} 
                  />
                </div>
                <div className="space-y-2">
                  <Label>Exact Score (1.0-5.0)</Label>
                  <Input 
                    type="number" 
                    step="0.1" min={1.0} max={5.0} 
                    value={score} 
                    onChange={(e) => setScore(e.target.value === "" ? "" : parseFloat(e.target.value))} 
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Override Justification <span className="text-red-500">*</span></Label>
                <Textarea 
                  placeholder="Explain why the AI-computed score is being adjusted..."
                  value={justification}
                  onChange={(e) => setJustification(e.target.value)}
                />
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={overrideScore.isPending || !justification}>
            {overrideScore.isPending ? "Saving..." : "Save Override"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
