import { useEffect, useState, type ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCurrency } from "@/lib/format";
import {
  useRecomputeNpv,
  useUpdateDeliverables,
  getGetDeliverablesQueryKey,
  type Deliverables,
  type NpvResult,
  type NpvInputs,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { DeliverableToolbar } from "@/components/deliverables/deliverable-toolbar";
import { LockBadge } from "@/components/deliverables/lock-badge";
import { Calculator, Info, Save } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * NPV view: shows the headline scenarios + lever breakdown plus an
 * editable inputs panel. The /npv/recompute endpoint is pure — it neither
 * persists nor snapshots — so the debounced live recompute lets the
 * assessor iterate freely. Only the explicit "Save" button persists the
 * working state through PATCH /deliverables, which is the single
 * authoritative write that produces a new version row.
 */
interface ViewProps {
  engagementId: string;
  deliverables: Deliverables;
}

export default function NpvView({ engagementId, deliverables }: ViewProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const recompute = useRecomputeNpv();
  const update = useUpdateDeliverables();

  // Local editable copy of the NPV result so recompute can re-render
  // immediately without waiting for the deliverables refetch.
  const [working, setWorking] = useState<NpvResult | null>(null);
  // Track which inputs the assessor edited so we only auto-recompute
  // when the assumptions change, not on every parent refetch.
  const [pendingInputs, setPendingInputs] = useState<Partial<NpvInputs> | null>(null);

  useEffect(() => {
    if (deliverables?.npv) setWorking(deliverables.npv);
  }, [deliverables?.npv]);

  // Derived view-state. Computed *before* the early return so that the
  // debounce effect below sees stable values. We accept that `data`/`base`
  // can be undefined here and gate the render on `working` further down.
  const isLocked = deliverables?.statuses?.npv === "locked";

  // Live recompute: 400ms after the last keystroke, push the inputs at the
  // pure server helper and splice the result back into the working copy.
  // Save stays a separate explicit action so the assessor can iterate
  // without persisting every intermediate state.
  //
  // IMPORTANT: This hook MUST run on every render (including the
  // "no NPV yet" early-return path below) so the rules-of-hooks invariant
  // holds. The internal guard short-circuits when there's nothing pending
  // or when the deliverable is locked.
  useEffect(() => {
    if (!pendingInputs || isLocked || !working) return;
    const handle = setTimeout(() => {
      const inputs: NpvInputs = {
        fullyLoadedCost: Math.max(0, Number(working.inputs.fullyLoadedCost ?? 200000)),
        teamCount: Math.max(1, Math.round(Number(working.inputs.teamCount ?? 8))),
        baselineCycleTimeDays: Math.max(1, Number(working.inputs.baselineCycleTimeDays ?? 14)),
        aiAcceptanceRate: Math.min(1, Math.max(0, Number(working.inputs.aiAcceptanceRate ?? 0.35))),
        reworkRate: Math.min(1, Math.max(0, Number(working.inputs.reworkRate ?? 0.18))),
        discountRate: Math.min(1, Math.max(0, Number(working.inputs.discountRate ?? 0.1))),
      };
      recompute.mutate(
        { id: engagementId, data: inputs },
        {
          onSuccess: (res) => {
            setWorking(res);
            setPendingInputs(null);
          },
          onError: () => setPendingInputs(null),
        },
      );
    }, 400);
    return () => clearTimeout(handle);
    // We deliberately depend only on the pendingInputs token so the
    // debounce restarts on each new edit without re-firing for unrelated
    // re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingInputs]);

  if (!deliverables?.npv || !working) {
    return <div className="p-8 text-center text-muted-foreground">No NPV analysis available.</div>;
  }

  const data = working;
  const base = data.scenarios.base;
  const dirty = JSON.stringify(working) !== JSON.stringify(deliverables.npv);

  // Map editable snapshot keys to the server's NpvInputs shape (the
  // OpenAPI body). All six fields are required so we clamp/round here and
  // never forward optional/legacy keys.
  const buildInputsBody = (): NpvInputs => ({
    fullyLoadedCost: Math.max(0, Number(data.inputs.fullyLoadedCost ?? 200000)),
    teamCount: Math.max(1, Math.round(Number(data.inputs.teamCount ?? 8))),
    baselineCycleTimeDays: Math.max(1, Number(data.inputs.baselineCycleTimeDays ?? 14)),
    aiAcceptanceRate: Math.min(1, Math.max(0, Number(data.inputs.aiAcceptanceRate ?? 0.35))),
    reworkRate: Math.min(1, Math.max(0, Number(data.inputs.reworkRate ?? 0.18))),
    discountRate: Math.min(1, Math.max(0, Number(data.inputs.discountRate ?? 0.1))),
  });

  const setInput = (key: keyof NpvInputs, value: number) => {
    setWorking((w) => (w ? { ...w, inputs: { ...w.inputs, [key]: value } } : w));
    setPendingInputs((p) => ({ ...(p ?? {}), [key]: value }));
  };

  const handleRecompute = () => {
    recompute.mutate(
      { id: engagementId, data: buildInputsBody() },
      {
        onSuccess: (res) => setWorking(res),
        onError: () => toast({ variant: "destructive", title: "Recompute failed" }),
      },
    );
  };

  const handleSave = () => {
    update.mutate(
      { id: engagementId, data: { npv: working } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetDeliverablesQueryKey(engagementId) });
          toast({ title: "Saved", description: "NPV recomputation persisted." });
        },
        onError: () => toast({ variant: "destructive", title: "Save failed" }),
      },
    );
  };

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Business Case (NPV)</h2>
          <p className="text-muted-foreground">Financial modeling for agentic transformation.</p>
        </div>
        <div className="flex items-center gap-3">
          <LockBadge meta={deliverables.lockMetadata?.npv} />
          <DeliverableToolbar engagementId={engagementId} deliverableKey="npv" status={deliverables.statuses.npv} hideRegenerate />
        </div>
      </div>

      <div className="grid md:grid-cols-3 gap-6 mb-8">
        <Card className="bg-primary text-primary-foreground">
          <CardHeader className="pb-2">
            <CardTitle className="text-primary-foreground/80 text-sm uppercase tracking-wider font-medium">3-Year NPV (Base Case)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold font-mono">{formatCurrency(base.npv3yr)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-sm uppercase tracking-wider font-medium">Payback Period</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold font-mono text-foreground">{base.paybackMonths} <span className="text-xl text-muted-foreground">months</span></div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-sm uppercase tracking-wider font-medium">Internal Rate of Return</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold font-mono text-foreground">{Math.round(base.irr * 100)}<span className="text-xl text-muted-foreground">%</span></div>
          </CardContent>
        </Card>
      </div>

      <div className="grid md:grid-cols-2 gap-8">
        <div>
          <div className="flex items-center justify-between mb-4 border-b pb-2">
            <h3 className="text-lg font-bold">Assumptions (Inputs)</h3>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={handleRecompute}
                disabled={isLocked || recompute.isPending}
              >
                <Calculator className="h-4 w-4 mr-1" />
                {recompute.isPending ? "Computing…" : "Recompute"}
              </Button>
              {dirty && (
                <Button size="sm" onClick={handleSave} disabled={isLocked || update.isPending}>
                  <Save className="h-4 w-4 mr-1" />
                  {update.isPending ? "Saving…" : "Save"}
                </Button>
              )}
            </div>
          </div>
          <div className="bg-muted/20 rounded-md border p-4 grid grid-cols-1 gap-3">
            <NpvField label="Fully Loaded Cost / FTE" value={data.inputs.fullyLoadedCost ?? 200000} step={5000}
              disabled={isLocked} onChange={(v) => setInput("fullyLoadedCost", v)}
              hint="Average all-in annual cost per engineer (salary, benefits, overhead) in USD. Typical range: $150,000–$300,000." />
            <NpvField label="Engineer Count (FTEs)" value={data.inputs.teamCount ?? 8} step={1}
              disabled={isLocked} onChange={(v) => setInput("teamCount", v)}
              hint="Number of engineers (FTEs) in scope for the rollout. Each engineer is costed at the Fully Loaded Cost above. Whole number, e.g. 1–500." />
            <NpvField label="Baseline Cycle Time (days)" value={data.inputs.baselineCycleTimeDays ?? 14} step={1}
              disabled={isLocked} onChange={(v) => setInput("baselineCycleTimeDays", v)}
              hint="Current average days from work started to delivered, before AI assistance. Typical range: 5–30 days." />
            <NpvField label="AI Acceptance Rate (0-1)" value={data.inputs.aiAcceptanceRate ?? 0.35} step={0.05}
              disabled={isLocked} onChange={(v) => setInput("aiAcceptanceRate", v)}
              hint="Expected share of AI suggestions developers will keep once AI tooling is rolled out — the assumed steady-state, not a baseline (there's no acceptance to measure before AI). Higher acceptance → more cycle-time savings. 0–1 means 0%–100%; 0.30–0.50 is common, based on tools like Copilot." />
            <NpvField label="Rework Rate (0-1)" value={data.inputs.reworkRate ?? 0.18} step={0.01}
              disabled={isLocked} onChange={(v) => setInput("reworkRate", v)}
              hint="Your team's current baseline — fraction of delivered work that has to be redone (defects, churn) today, before AI. The model assumes AI eliminates about half of this rework. 0–1 means 0%–100%; 0.10–0.25 is typical." />
            <NpvField label="Discount Rate (0-1)" value={data.inputs.discountRate ?? 0.1} step={0.01}
              disabled={isLocked} onChange={(v) => setInput("discountRate", v)}
              hint={
                <div className="space-y-2">
                  <p>
                    Annual rate used to convert future savings into today's dollars (the
                    time-value of money). <span className="font-mono">0–1</span> means
                    0%–100%; <span className="font-mono">0.10</span> is 10% per year.
                  </p>
                  <p>
                    Year-1 savings are divided by <span className="font-mono">(1 + rate)</span>,
                    year-2 by <span className="font-mono">(1 + rate)²</span>, year-3 by
                    {" "}<span className="font-mono">(1 + rate)³</span>, then summed for the
                    3-Year NPV.
                  </p>
                  <div>
                    <p className="font-medium text-primary-foreground">What changing it does</p>
                    <ul className="list-disc pl-4 space-y-0.5">
                      <li>Higher rate → future savings count for less → NPV goes down. Use for risky rollouts or a high hurdle rate.</li>
                      <li>Lower rate → future savings count nearly as much as year 1 → NPV goes up. Use when capital is cheap and savings are low-risk.</li>
                      <li>0 means no time-value adjustment.</li>
                    </ul>
                  </div>
                  <p>Typical: 0.08–0.12 (your company's WACC or hurdle rate).</p>
                </div>
              } />
          </div>
        </div>

        <div>
          <h3 className="text-lg font-bold mb-4 border-b pb-2">Value Levers</h3>
          {(() => {
            const segmentColors = ["bg-chart-1", "bg-chart-2", "bg-chart-3"];
            const total = data.leverBreakdown.reduce(
              (sum, l) => sum + Math.max(0, l.savings),
              0,
            );
            const hasSavings = total > 0;
            const segments = data.leverBreakdown.map((lever, i) => {
              const value = Math.max(0, lever.savings);
              const share = hasSavings ? value / total : 0;
              return {
                lever: lever.lever,
                savings: value,
                share,
                pct: share * 100,
                color: segmentColors[i % segmentColors.length],
              };
            });
            // Build a concise text summary so assistive tech announces the
            // breakdown the same way a sighted user reads the bar. The
            // segments themselves are aria-hidden so they don't produce a
            // separate stream of announcements alongside the legend list
            // below.
            const barAriaLabel = hasSavings
              ? `Annual savings split: ${segments
                  .map((s) => `${s.lever} ${s.pct.toFixed(0)}%`)
                  .join(", ")}`
              : "Annual savings split: no savings yet";
            return (
              <div className="pt-2">
                <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                  Share of annual savings
                </p>
                <div
                  className="w-full bg-muted rounded-full h-3 overflow-hidden flex"
                  data-testid="lever-stacked-bar"
                  role="img"
                  aria-label={barAriaLabel}
                >
                  {hasSavings ? (
                    segments.map((s) => (
                      <div
                        key={s.lever}
                        className={`${s.color} h-full`}
                        style={{ width: `${s.pct}%` }}
                        title={`${s.lever}: ${formatCurrency(s.savings)} (${s.pct.toFixed(0)}%)`}
                        data-testid={`lever-segment-${s.lever}`}
                        aria-hidden="true"
                      />
                    ))
                  ) : null}
                </div>
                {!hasSavings ? (
                  <p className="text-xs text-muted-foreground mt-2 italic">
                    No savings yet — adjust the inputs to see lever
                    contributions.
                  </p>
                ) : null}
                <ul className="mt-4 space-y-2">
                  {segments.map((s) => (
                    <li
                      key={s.lever}
                      className="flex items-center gap-3 text-sm"
                      data-testid={`lever-legend-${s.lever}`}
                    >
                      <span
                        className={`${s.color} inline-block h-3 w-3 rounded-sm shrink-0`}
                        aria-hidden="true"
                      />
                      <span className="font-medium text-foreground flex-1 min-w-0 truncate">
                        {s.lever}
                      </span>
                      <span className="font-mono text-muted-foreground tabular-nums">
                        {formatCurrency(s.savings)}
                      </span>
                      <span className="font-mono text-muted-foreground tabular-nums w-12 text-right">
                        {hasSavings ? `${s.pct.toFixed(0)}%` : "—"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

function NpvField({
  label,
  value,
  step,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  value: number;
  step: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 items-center">
      <div className="flex items-center gap-1.5 min-w-0">
        <Label className="text-sm text-muted-foreground">{label}</Label>
        {hint && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`What is ${label}?`}
                className="inline-flex shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              >
                <Info className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-sm text-xs leading-snug">
              {hint}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      <Input
        type="number"
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        className="font-mono text-right"
      />
    </div>
  );
}
