import { useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useParams } from "wouter";
import {
  useGetScoring,
  useComputeScoring,
  useOverrideDimensionScore,
  useListRubrics,
  usePreviewScoring,
  useUpgradeScoringRubric,
  getGetScoringQueryKey,
  type Scoring,
  type DimensionScore,
} from "@workspace/api-client-react";
import { DeltaTable } from "@/pages/rubrics";
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
import { Calculator, Target, Info, AlertTriangle, FileText, CheckCircle2, Hexagon, PieChart as PieIcon } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useToast } from "@/hooks/use-toast";
import { formatRelative } from "@/lib/format";
import { stageFill, stageTextColor, identityColor } from "@/lib/dimension-palette";
import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
  Tooltip,
} from "recharts";

export default function ScoringView() {
  const params = useParams();
  const id = params.id as string;
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: scoring, isLoading } = useGetScoring(id, {
    query: { enabled: !!id, queryKey: getGetScoringQueryKey(id) },
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
          <h1 className="text-3xl font-bold tracking-tight">Scoring Dashboard</h1>
          <p className="text-muted-foreground mt-1 flex items-center gap-2 flex-wrap">
            Maturity evaluation across 6 key dimensions.
            {scoring?.computedAt && (
              <span className="text-xs border rounded px-1.5 py-0.5 bg-muted/50">
                Last computed {formatRelative(scoring.computedAt)}
              </span>
            )}
            {scoring?.rubricVersion && (
              <Badge variant="outline" className="font-mono text-xs">
                Rubric v{scoring.rubricVersion}
              </Badge>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <UpgradeRubricButton
            engagementId={id}
            scoring={scoring ?? null}
          />
          <Button onClick={handleCompute} disabled={computeScoring.isPending} className="gap-2">
            <Calculator className="h-4 w-4" />
            {computeScoring.isPending ? "Computing..." : "Score all"}
          </Button>
        </div>
      </div>

      <div className="mb-8 p-6 bg-primary text-primary-foreground rounded-lg shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg mb-1 text-primary-foreground/80">Overall Agentic Maturity</h2>
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
              <div className="text-2xl">Stage {Math.ceil(scoring.overall.score)}</div>
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
          <h3 className="text-xl font-semibold mb-2">No Scores Computed</h3>
          <p className="text-muted-foreground mb-6 max-w-md mx-auto">
            Collect evidence via connectors, surveys, and interviews, then run the scoring algorithm to generate maturity scores.
          </p>
          <Button onClick={handleCompute} disabled={computeScoring.isPending} size="lg">
            <Calculator className="mr-2 h-5 w-5" />
            Compute Scores Now
          </Button>
        </div>
      ) : (
        <>
          <MaturityVizCard dimensions={scoring.byDimension} />
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {scoring.byDimension.map((dim) => (
            <OverrideDialog 
              key={dim.dimension} 
              engagementId={id} 
              dimension={dim} 
              trigger={
                <Card className="cursor-pointer hover-elevate hover:border-primary/50 transition-all h-full flex flex-col overflow-hidden relative">
                  <div
                    aria-hidden
                    className="absolute inset-x-0 top-0 h-1"
                    style={{ background: identityColor(dim.dimension) }}
                  />
                  <CardHeader className="pb-2 pt-4">
                    <div className="flex justify-between items-start">
                      <CardTitle className="text-lg capitalize flex items-center gap-2">
                        <span
                          aria-hidden
                          className="inline-block h-2.5 w-2.5 rounded-full"
                          style={{ background: identityColor(dim.dimension) }}
                        />
                        {dim.dimension}
                      </CardTitle>
                      <Badge variant="outline" className={getConfidenceColor(dim.confidence)}>
                        {dim.confidence} conf
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="flex-1">
                    <div className="flex items-end gap-2 mb-4">
                      <span
                        className="text-3xl font-bold"
                        style={{ color: stageTextColor(dim.dimension, dim.stage) }}
                      >
                        Stage {dim.stage}
                      </span>
                      <span className="text-sm text-muted-foreground font-medium font-mono mb-1">Score {dim.score.toFixed(1)}</span>
                    </div>
                    <p className="text-sm text-muted-foreground line-clamp-3" title={dim.rationale}>
                      {dim.rationale}
                    </p>
                    {dim.overrideJustification && (
                      <div className="mt-4 p-2 bg-yellow-500/10 border border-yellow-500/20 rounded text-xs text-yellow-800 dark:text-yellow-400 flex gap-2 items-start">
                        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                        <div className="space-y-0.5">
                          <div>
                            <span className="font-medium">Overridden</span>
                            {(dim.overrideAuthorName || dim.overrideAuthorEmail) && (
                              <span> by {dim.overrideAuthorName || dim.overrideAuthorEmail}</span>
                            )}
                            {dim.overrideAt && (
                              <span className="opacity-70">
                                {" "}· {new Date(dim.overrideAt).toLocaleDateString()}
                              </span>
                            )}
                          </div>
                          <div className="opacity-90">{dim.overrideJustification}</div>
                        </div>
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
        </>
      )}
    </AppLayout>
  );
}

function MaturityVizCard({ dimensions }: { dimensions: Array<{ dimension: string; score: number; stage: number }> }) {
  const [view, setView] = useState<"radar" | "coxcomb">("coxcomb");
  return (
    <Card className="mb-8">
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="text-lg">Maturity Radar</CardTitle>
          <p className="text-sm text-muted-foreground">All 6 dimensions on a 1–5 scale.</p>
        </div>
        <ToggleGroup
          type="single"
          value={view}
          onValueChange={(v) => v && setView(v as "radar" | "coxcomb")}
          variant="outline"
          size="sm"
          data-testid="toggle-maturity-viz"
        >
          <ToggleGroupItem value="radar" aria-label="Radar (spider) chart" data-testid="toggle-radar">
            <Hexagon className="h-4 w-4 mr-1.5" />
            Radar
          </ToggleGroupItem>
          <ToggleGroupItem value="coxcomb" aria-label="Coxcomb (polar area) chart" data-testid="toggle-coxcomb">
            <PieIcon className="h-4 w-4 mr-1.5" />
            Coxcomb
          </ToggleGroupItem>
        </ToggleGroup>
      </CardHeader>
      <CardContent>
        {view === "radar" ? (
          <DimensionRadar dimensions={dimensions} />
        ) : (
          <DimensionCoxcomb dimensions={dimensions} />
        )}
      </CardContent>
    </Card>
  );
}

function DimensionCoxcomb({ dimensions }: { dimensions: Array<{ dimension: string; score: number; stage: number }> }) {
  // True coxcomb / Nightingale rose: each dimension gets an equal angular slice;
  // the radial extent of each slice scales with score / 5. Drawn directly in SVG
  // for predictable geometry — Recharts has no first-class coxcomb primitive.
  // Animation, hover-highlight, and tooltip are layered on with framer-motion +
  // local state so the experience matches the radar view's polish.
  const n = dimensions.length;
  const [hovered, setHovered] = useState<number | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; idx: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  if (n === 0) return <div className="w-full h-[380px]" />;
  const size = 380;
  const cx = size / 2;
  const cy = size / 2;
  const maxR = size * 0.36;
  const labelR = size * 0.46;
  const sliceAngle = (2 * Math.PI) / n;
  const startOffset = -Math.PI / 2 - sliceAngle / 2;
  const polar = (r: number, a: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
  const rings = [1, 2, 3, 4, 5].map((stage) => (maxR * stage) / 5);

  // Always emits the same `M-L-A-Z` command structure so framer-motion can
  // smoothly interpolate `d` between initial (radius epsilon) and final.
  const pathFor = (stage: number, a0: number, a1: number) => {
    const rRaw = (Math.max(0, Math.min(5, stage)) / 5) * maxR;
    const r = Math.max(rRaw, 0.5);
    const [x0, y0] = polar(r, a0);
    const [x1, y1] = polar(r, a1);
    const largeArc = sliceAngle > Math.PI ? 1 : 0;
    return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${largeArc} 1 ${x1} ${y1} Z`;
  };

  const handleMove = (e: React.MouseEvent<Element>, idx: number) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTip({ x: e.clientX - rect.left, y: e.clientY - rect.top, idx });
  };

  const tipDim = tip ? dimensions[tip.idx] : null;

  return (
    <div
      ref={wrapRef}
      className="w-full h-[380px] flex items-center justify-center relative"
      onMouseLeave={() => {
        setHovered(null);
        setTip(null);
      }}
    >
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="w-full h-full max-w-[520px]"
        role="img"
        aria-label="Coxcomb chart of maturity scores"
        data-testid="chart-coxcomb"
      >
        {/* concentric guide rings */}
        {rings.map((r, i) => (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke="hsl(var(--border))"
            strokeWidth={1}
            strokeDasharray={i === rings.length - 1 ? "0" : "2 3"}
          />
        ))}
        {/* radial scale labels at top */}
        {rings.map((r, i) => (
          <text
            key={`s${i}`}
            x={cx + 4}
            y={cy - r}
            fontSize={10}
            fill="hsl(var(--muted-foreground))"
            dominantBaseline="middle"
          >
            Stage {i + 1}
          </text>
        ))}
        {/* slices */}
        {dimensions.map((d, i) => {
          const a0 = startOffset + i * sliceAngle;
          const a1 = a0 + sliceAngle;
          const baseOpacity = 0.35 + (d.stage / 5) * 0.45;
          const isHovered = hovered === i;
          const isDimmed = hovered !== null && !isHovered;
          const fillOpacity = isHovered ? 0.95 : isDimmed ? baseOpacity * 0.45 : baseOpacity;
          const strokeWidth = isHovered ? 2.5 : 1.5;
          const labelAngle = a0 + sliceAngle / 2;
          const [lx, ly] = polar(labelR, labelAngle);
          const anchor =
            Math.abs(Math.cos(labelAngle)) < 0.15
              ? "middle"
              : Math.cos(labelAngle) > 0
                ? "start"
                : "end";
          const finalPath = pathFor(d.stage, a0, a1);
          const initialPath = pathFor(0, a0, a1);
          return (
            <g key={d.dimension}>
              <motion.path
                initial={{ d: initialPath, opacity: 0 }}
                animate={{ d: finalPath, opacity: 1 }}
                transition={{
                  d: { duration: 0.7, delay: i * 0.06, ease: [0.22, 1, 0.36, 1] },
                  opacity: { duration: 0.25, delay: i * 0.06 },
                }}
                fill={stageFill(d.dimension, d.stage)}
                fillOpacity={fillOpacity}
                stroke={identityColor(d.dimension)}
                strokeWidth={strokeWidth}
                style={{ cursor: "pointer", transition: "fill-opacity 150ms, stroke-width 150ms" }}
                onMouseEnter={(e) => {
                  setHovered(i);
                  handleMove(e as unknown as React.MouseEvent, i);
                }}
                onMouseMove={(e) => handleMove(e as unknown as React.MouseEvent, i)}
                data-testid={`coxcomb-slice-${d.dimension}`}
              />
              <text
                x={lx}
                y={ly}
                fontSize={12}
                fontWeight={600}
                fill="hsl(var(--foreground))"
                fillOpacity={isDimmed ? 0.55 : 1}
                textAnchor={anchor}
                dominantBaseline="middle"
                style={{ textTransform: "capitalize", pointerEvents: "none", transition: "fill-opacity 150ms" }}
              >
                {d.dimension}
              </text>
              <text
                x={lx}
                y={ly + 14}
                fontSize={11}
                fill="hsl(var(--muted-foreground))"
                fillOpacity={isDimmed ? 0.55 : 1}
                textAnchor={anchor}
                dominantBaseline="middle"
                style={{ pointerEvents: "none", transition: "fill-opacity 150ms" }}
              >
                Stage {d.stage}
              </text>
            </g>
          );
        })}
      </svg>
      <AnimatePresence>
        {tip && tipDim && (
          <motion.div
            key="coxcomb-tip"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.12 }}
            className="pointer-events-none absolute z-10 rounded-md border px-3 py-2 text-xs shadow-md"
            style={{
              left: Math.min(Math.max(tip.x + 12, 0), (wrapRef.current?.clientWidth ?? 999) - 180),
              top: Math.max(tip.y - 8, 0),
              background: "hsl(var(--card))",
              borderColor: "hsl(var(--border))",
              color: "hsl(var(--foreground))",
            }}
            data-testid="coxcomb-tooltip"
          >
            <div className="font-semibold capitalize mb-0.5">{tipDim.dimension}</div>
            <div className="font-semibold">Stage {tipDim.stage}</div>
            <div className="text-muted-foreground text-[11px] font-mono">Score {tipDim.score.toFixed(2)} / 5</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function DimensionRadar({ dimensions }: { dimensions: Array<{ dimension: string; score: number; stage: number }> }) {
  const data = dimensions.map((d) => ({
    dimension: d.dimension.charAt(0).toUpperCase() + d.dimension.slice(1),
    stage: d.stage,
    score: Number((d.score ?? 0).toFixed(2)),
    fullMark: 5,
  }));
  return (
    <div className="w-full h-[380px]">
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={data} outerRadius="78%">
          <PolarGrid stroke="hsl(var(--border))" />
          <PolarAngleAxis
            dataKey="dimension"
            tick={{ fill: "hsl(var(--foreground))", fontSize: 13, fontWeight: 600 }}
          />
          <PolarRadiusAxis
            angle={90}
            domain={[0, 5]}
            tickCount={6}
            tickFormatter={(v: number) => (v >= 1 ? `Stage ${v}` : "")}
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
            stroke="hsl(var(--border))"
          />
          <Radar
            name="Maturity"
            dataKey="stage"
            stroke="hsl(var(--primary))"
            fill="hsl(var(--primary))"
            fillOpacity={0.35}
            strokeWidth={2}
            dot={{ r: 4, fill: "hsl(var(--accent))", stroke: "hsl(var(--primary))", strokeWidth: 2 }}
            label={{
              fill: "hsl(var(--foreground))",
              fontSize: 12,
              fontWeight: 700,
              offset: 8,
              formatter: (v: number) => `Stage ${v}`,
            }}
          />
          <Tooltip
            contentStyle={{
              background: "hsl(var(--card))",
              border: "1px solid hsl(var(--border))",
              borderRadius: 8,
              color: "hsl(var(--foreground))",
            }}
            formatter={(v: number, _name: string, item: { payload?: { score?: number } }) => {
              const score = item?.payload?.score;
              const secondary = typeof score === "number" ? ` (Score ${score.toFixed(2)})` : "";
              return [`Stage ${v}${secondary}`, "Maturity"];
            }}
          />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}

function OverrideDialog({ engagementId, dimension, trigger }: { engagementId: string, dimension: DimensionScore, trigger: React.ReactNode }) {
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
          <DialogTitle className="text-2xl capitalize">
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
            <h4 className="text-lg font-bold mb-4 flex items-center gap-2">
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

function UpgradeRubricButton({
  engagementId,
  scoring,
}: {
  engagementId: string;
  scoring: Scoring | null;
}) {
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState<string>("");
  const [previewResult, setPreviewResult] = useState<{
    preview: Scoring;
    current?: Scoring | null;
  } | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: rubrics } = useListRubrics();
  const preview = usePreviewScoring();
  const upgrade = useUpgradeScoringRubric();

  const published = (rubrics ?? []).filter((r) => r.status === "published");
  const candidates = published.filter(
    (r) => r.id !== scoring?.rubricVersionId,
  );

  function handlePreview(rubricId: string) {
    setTargetId(rubricId);
    setPreviewResult(null);
    preview.mutate(
      { id: engagementId, data: { rubricVersionId: rubricId } },
      {
        onSuccess: (r) => setPreviewResult(r),
        onError: (err) =>
          toast({
            variant: "destructive",
            title: "Preview failed",
            description: err instanceof Error ? err.message : "",
          }),
      },
    );
  }

  function handleConfirm() {
    if (!targetId) return;
    upgrade.mutate(
      { id: engagementId, data: { rubricVersionId: targetId } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getGetScoringQueryKey(engagementId),
          });
          toast({ title: "Rubric upgraded" });
          setOpen(false);
          setPreviewResult(null);
          setTargetId("");
        },
        onError: (err) =>
          toast({
            variant: "destructive",
            title: "Upgrade failed",
            description: err instanceof Error ? err.message : "",
          }),
      },
    );
  }

  if (candidates.length === 0) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setPreviewResult(null);
          setTargetId("");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <CheckCircle2 className="h-4 w-4" />
          Upgrade rubric
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Upgrade scoring rubric</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label>Target version</Label>
            <div className="flex flex-wrap gap-2">
              {candidates.map((r) => (
                <Button
                  key={r.id}
                  variant={targetId === r.id ? "default" : "outline"}
                  size="sm"
                  onClick={() => handlePreview(r.id)}
                  disabled={preview.isPending && targetId === r.id}
                >
                  v{r.version}
                </Button>
              ))}
            </div>
          </div>
          {preview.isPending && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Info className="h-4 w-4" /> Previewing…
            </div>
          )}
          {previewResult && (
            <DeltaTable
              preview={previewResult.preview}
              current={previewResult.current ?? null}
            />
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={!previewResult || upgrade.isPending}
            onClick={handleConfirm}
          >
            {upgrade.isPending ? "Upgrading…" : "Confirm upgrade"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
