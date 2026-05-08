import { Fragment, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dimension,
  useUpdateDeliverables,
  getGetDeliverablesQueryKey,
  type Deliverables,
  type ActionItem,
  type ActionItemPriority,
  type ActionItemEffort,
  type ActionItemImpact,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { DeliverableToolbar } from "@/components/deliverables/deliverable-toolbar";
import { LockBadge } from "@/components/deliverables/lock-badge";
import { identityColor } from "@/lib/dimension-palette";
import { Trash2, Plus, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const PRIORITIES = ["P0", "P1", "P2"] as const;
const SIZES = ["S", "M", "L", "XL"] as const;

// Effort buckets translate t-shirt sizes into approximate calendar weeks.
// These are rough rollout estimates, not contractual durations.
const EFFORT_WEEKS: Record<ActionItemEffort, number> = {
  S: 2,
  M: 6,
  L: 12,
  XL: 16,
};

// FullStack delivery hours per t-shirt size, used to pre-populate costEstimate.
const EFFORT_HOURS: Record<ActionItemEffort, number> = {
  S: 80,
  M: 240,
  L: 480,
  XL: 640,
};

const DEFAULT_DELIVERY_RATE = 250;

const VALUE_LEVER_LABELS: Record<string, string> = {
  cycle_time: "Cycle Time Reduction",
  rework: "Rework Reduction",
  review: "Code Review Acceleration",
  onboarding: "Onboarding Acceleration",
  test_quality: "Test Coverage & Quality",
  mttr: "Incident Resolution (MTTR)",
};

const IMPACT_PRESETS = [
  { label: "Low", value: 0.05 },
  { label: "Medium", value: 0.10 },
  { label: "High", value: 0.20 },
] as const;

const PRIORITY_RANK: Record<ActionItemPriority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
};

// Each step down in priority order shifts the bar one week to the right so
// higher-priority items visibly start sooner while still allowing overlap.
const STAGGER_WEEKS = 1;
// Minimum bar density so a long timeline (many weeks) still gets a horizontal
// scroll instead of squishing every label to nothing. We let the inner grid
// fill the available container width by default (CSS percentages) and only
// switch to fixed pixels — and a scrollbar — when the natural width would
// dip below this threshold per week.
const MIN_PIXELS_PER_WEEK = 22;
// Minimum on-screen bar width so even an S-effort, single-week initiative
// remains clickable on very compressed timelines.
const MIN_BAR_PX = 16;

interface DerivedBar {
  item: ActionItem;
  startWeek: number;
  widthWeeks: number;
  color: string;
}

function deriveTimeline(items: ActionItem[]): DerivedBar[] {
  const sorted = items
    .map((item, originalIndex) => ({ item, originalIndex }))
    .sort((a, b) => {
      const pri = PRIORITY_RANK[a.item.priority] - PRIORITY_RANK[b.item.priority];
      if (pri !== 0) return pri;
      return a.originalIndex - b.originalIndex;
    });
  return sorted.map((entry, sortedIndex) => ({
    item: entry.item,
    startWeek: sortedIndex * STAGGER_WEEKS,
    widthWeeks: EFFORT_WEEKS[entry.item.effort] ?? 4,
    color: identityColor(entry.item.dimension),
  }));
}

interface MonthSegment {
  label: string;
  weeks: number;
}

function buildMonthSegments(totalWeeks: number, today: Date): MonthSegment[] {
  const segments: MonthSegment[] = [];
  let currentMonth = -1;
  let currentYear = -1;
  for (let w = 0; w < totalWeeks; w++) {
    const date = new Date(today);
    date.setDate(date.getDate() + w * 7);
    const m = date.getMonth();
    const y = date.getFullYear();
    if (m !== currentMonth || y !== currentYear) {
      segments.push({
        label: date.toLocaleString("en-US", { month: "short", year: "2-digit" }),
        weeks: 1,
      });
      currentMonth = m;
      currentYear = y;
    } else {
      segments[segments.length - 1]!.weeks += 1;
    }
  }
  return segments;
}

function ActionPlanTimeline({ items, deliveryRate }: { items: ActionItem[]; deliveryRate: number }) {
  const today = useMemo(() => new Date(), []);
  const derived = useMemo(() => deriveTimeline(items), [items]);
  const totalWeeks = useMemo(() => {
    const max = derived.reduce((acc, d) => Math.max(acc, d.startWeek + d.widthWeeks), 0);
    // Always show at least 8 weeks of runway so the axis is never lonely.
    return Math.max(max, 8);
  }, [derived]);
  const months = useMemo(() => buildMonthSegments(totalWeeks, today), [totalWeeks, today]);

  if (derived.length === 0) return null;

  const handleBarClick = (id: string) => {
    const row =
      typeof document !== "undefined"
        ? document.querySelector<HTMLElement>(`[data-action-row="${CSS.escape(id)}"]`)
        : null;
    if (row) {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    // Optional integration with the per-row expand handler installed by
    // ActionPlanView. Guarded so the timeline keeps working even if the
    // accordion-rows feature is ever disabled or replaced.
    const expander = (
      window as unknown as {
        __pulseExpandActionRow?: (rowId: string) => void;
      }
    ).__pulseExpandActionRow;
    if (typeof expander === "function") {
      try {
        expander(id);
      } catch {
        /* ignore — expander is best-effort */
      }
    }
  };

  // Natural pixel floor for the timeline so labels stay legible. When the
  // panel is wider than this floor (the common case on a desktop tab), the
  // inner grid stretches to 100% via CSS. When it's narrower, the floor wins
  // and the outer wrapper scrolls horizontally. No JS measurement needed.
  const minWidthPx = totalWeeks * MIN_PIXELS_PER_WEEK;
  const pct = (weeks: number) => `${(weeks / totalWeeks) * 100}%`;

  return (
    <div className="mb-6 border rounded-md shadow-sm bg-card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
        <h3 className="text-sm font-semibold text-foreground">Approximate timeline</h3>
        <span className="text-xs text-muted-foreground">
          {derived.length} {derived.length === 1 ? "initiative" : "initiatives"} · ~{totalWeeks} weeks
        </span>
      </div>
      <div className="overflow-x-auto">
        <div style={{ minWidth: `${minWidthPx}px`, width: "100%" }}>
          <div className="flex border-b">
            {months.map((m, i) => (
              <div
                key={`${m.label}-${i}`}
                style={{ width: pct(m.weeks) }}
                className="px-2 py-1 text-xs font-medium text-muted-foreground border-r last:border-r-0 bg-muted/20"
              >
                {m.label}
              </div>
            ))}
          </div>
          <div
            className="grid border-b"
            style={{ gridTemplateColumns: `repeat(${totalWeeks}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: totalWeeks }).map((_, w) => (
              <div
                key={w}
                className="py-0.5 text-center text-[10px] text-muted-foreground/60 border-r border-border/40 last:border-r-0"
              >
                {w + 1}
              </div>
            ))}
          </div>
          <div className="py-2 relative">
            {derived.map(({ item, startWeek, widthWeeks, color }) => (
              <div key={item.id} className="relative h-7 my-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => handleBarClick(item.id)}
                      aria-label={`${item.initiative} — ${item.dimension}, effort ${item.effort}, impact ${item.impact}`}
                      className="absolute h-6 top-0.5 rounded-sm border border-white/40 hover:ring-2 hover:ring-foreground/40 focus-visible:ring-2 focus-visible:ring-foreground/60 outline-none transition flex items-center px-2 text-xs text-white overflow-hidden"
                      style={{
                        left: pct(startWeek),
                        width: pct(widthWeeks),
                        minWidth: `${MIN_BAR_PX}px`,
                        backgroundColor: color,
                      }}
                    >
                      <span className="truncate font-medium">{item.initiative}</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs bg-popover text-popover-foreground border">
                    <div className="space-y-1 text-xs">
                      <div className="font-semibold text-sm">{item.initiative}</div>
                      <div className="capitalize">
                        <span className="text-muted-foreground">Dimension: </span>
                        {item.dimension}
                      </div>
                      <div>
                        <span className="text-muted-foreground">Effort: </span>
                        {item.effort}
                        <span className="text-muted-foreground"> · Impact: </span>
                        {item.impact}
                      </div>
                      <div>
                        <span className="text-muted-foreground">Owner: </span>
                        {item.ownerRole || "Unassigned"}
                      </div>
                      <div>
                        <span className="text-muted-foreground">Cost est.: </span>
                        <span className="font-mono">
                          ${((item.costEstimate ?? EFFORT_HOURS[item.effort] * deliveryRate) / 1000).toFixed(0)}k
                        </span>
                        {item.costEstimate == null && (
                          <span className="text-muted-foreground ml-1">(formula)</span>
                        )}
                        {item.costEstimate != null && (
                          <span className="text-amber-600 dark:text-amber-400 ml-1">(overridden)</span>
                        )}
                      </div>
                      {item.valueLever && (
                        <div>
                          <span className="text-muted-foreground">Lever: </span>
                          <span>↑ {VALUE_LEVER_LABELS[item.valueLever] ?? item.valueLever}</span>
                        </div>
                      )}
                    </div>
                  </TooltipContent>
                </Tooltip>
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="px-4 py-2 text-xs text-muted-foreground border-t bg-muted/10">
        Approximate timeline derived from priority and effort. The Action Plan does not yet include
        real start or end dates.
      </p>
    </div>
  );
}

interface ViewProps {
  engagementId: string;
  deliverables: Deliverables;
}

export default function ActionPlanView({ engagementId, deliverables }: ViewProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const update = useUpdateDeliverables();
  // Editable copy of the action plan; serialized straight back to the
  // server when the assessor clicks Save.
  const [items, setItems] = useState<ActionItem[]>([]);
  // Only one row is expanded at a time so the table stays compact and
  // assessors don't lose track of where their cursor is.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  useEffect(() => {
    if (deliverables?.actionPlan) setItems(deliverables.actionPlan);
  }, [deliverables?.actionPlan]);

  // Bridge for the timeline's bar-click integration: clicking a bar should
  // both scroll to and expand the matching row.
  useEffect(() => {
    const w = window as unknown as {
      __pulseExpandActionRow?: (rowId: string) => void;
    };
    w.__pulseExpandActionRow = (rowId: string) => setExpandedId(rowId);
    return () => {
      if (w.__pulseExpandActionRow) delete w.__pulseExpandActionRow;
    };
  }, []);

  if (!deliverables?.actionPlan) {
    return <div className="p-8 text-center text-muted-foreground">No action plan available.</div>;
  }

  // Use the live delivery rate from NPV inputs so cost display is consistent with
  // the Business Case tab. Falls back to DEFAULT_DELIVERY_RATE when NPV hasn't been set.
  const currentRate: number =
    typeof deliverables.npv?.inputs?.deliveryHourlyRate === "number"
      ? deliverables.npv.inputs.deliveryHourlyRate
      : DEFAULT_DELIVERY_RATE;

  const isLocked = deliverables.statuses.actionPlan === "locked";
  const dirty = JSON.stringify(items) !== JSON.stringify(deliverables.actionPlan);

  const setItem = (id: string, patch: Partial<ActionItem>) =>
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const removeItem = (id: string) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
    setExpandedId((cur) => (cur === id ? null : cur));
  };
  const addItem = () =>
    setItems((xs) => [
      ...xs,
      {
        id: `tmp-${Date.now()}`,
        initiative: "New initiative",
        dimension: Object.values(Dimension)[0],
        priority: "P1",
        effort: "M",
        impact: "M",
        ownerRole: "",
        successMetric: "",
        dependencies: [],
        // costEstimate intentionally omitted: the formula provides the default display;
        // a stored value means the assessor explicitly overrode it.
      },
    ]);

  const toggleExpanded = (id: string) =>
    setExpandedId((cur) => (cur === id ? null : id));

  const handleRowKeyDown = (e: KeyboardEvent<HTMLTableRowElement>, id: string) => {
    if (e.key === "Enter" || e.key === " ") {
      // Don't hijack typing inside inputs/selects/buttons within the row.
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, button, [role='combobox']")) return;
      e.preventDefault();
      toggleExpanded(id);
    }
  };

  const save = () => {
    update.mutate(
      { id: engagementId, data: { actionPlan: items } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetDeliverablesQueryKey(engagementId) });
          toast({ title: "Saved", description: "Action plan updated." });
        },
        onError: () => toast({ variant: "destructive", title: "Save failed" }),
      },
    );
  };

  // Total column count varies because the delete column only shows when unlocked.
  const totalColumns = isLocked ? 8 : 9;

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Strategic Action Plan</h2>
          <p className="text-muted-foreground">Prioritized initiatives to reach target state.</p>
        </div>
        <div className="flex items-center gap-3">
          <LockBadge meta={deliverables.lockMetadata?.actionPlan} />
          <DeliverableToolbar
            engagementId={engagementId}
            deliverableKey="actionPlan"
            status={deliverables.statuses.actionPlan}
          />
        </div>
      </div>

      {!isLocked && (
        <div className="mb-4 flex items-center justify-end gap-2">
          <Button size="sm" variant="outline" onClick={addItem}>
            <Plus className="h-4 w-4 mr-1" /> Add row
          </Button>
          {dirty && (
            <Button size="sm" onClick={save} disabled={update.isPending}>
              {update.isPending ? "Saving…" : "Save changes"}
            </Button>
          )}
        </div>
      )}

      <ActionPlanTimeline items={items} deliveryRate={currentRate} />

      <div className="border rounded-md shadow-sm overflow-hidden">
        <Table className="table-fixed">
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="w-10" aria-label="Expand row" />
              <TableHead className="w-24">Priority</TableHead>
              <TableHead>Initiative</TableHead>
              <TableHead className="w-36">Dimension</TableHead>
              <TableHead className="w-20">Effort</TableHead>
              <TableHead className="w-20">Impact</TableHead>
              <TableHead className="w-40">Owner</TableHead>
              <TableHead>Success metric</TableHead>
              {!isLocked && <TableHead className="w-12" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => {
              const isExpanded = expandedId === item.id;
              const panelId = `action-plan-panel-${item.id}`;
              return (
                <Fragment key={item.id}>
                  <TableRow
                    data-action-row={item.id}
                    className="bg-card align-top cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-expanded={isExpanded}
                    aria-controls={panelId}
                    tabIndex={0}
                    onClick={(e) => {
                      const target = e.target as HTMLElement;
                      if (target.closest("input, textarea, select, button, [role='combobox']")) return;
                      toggleExpanded(item.id);
                    }}
                    onKeyDown={(e) => handleRowKeyDown(e, item.id)}
                  >
                    <TableCell className="w-10">
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        aria-label={isExpanded ? "Collapse row" : "Expand row"}
                        aria-expanded={isExpanded}
                        aria-controls={panelId}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpanded(item.id);
                        }}
                        className="h-8 w-8 p-0 text-muted-foreground"
                      >
                        <ChevronRight
                          className={cn(
                            "h-4 w-4 transition-transform",
                            isExpanded && "rotate-90",
                          )}
                        />
                      </Button>
                    </TableCell>
                    <TableCell>
                      {isLocked ? (
                        <Badge
                          variant={
                            item.priority === "P0" ? "destructive" : item.priority === "P1" ? "default" : "secondary"
                          }
                          className="font-mono"
                        >
                          {item.priority}
                        </Badge>
                      ) : (
                        <Select value={item.priority} onValueChange={(v) => setItem(item.id, { priority: v as ActionItemPriority })}>
                          <SelectTrigger className="h-8 w-20 font-mono"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {PRIORITIES.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      )}
                    </TableCell>
                    <TableCell className="font-medium text-base">
                      {isLocked ? (
                        <div className="truncate" title={item.initiative}>{item.initiative}</div>
                      ) : (
                        <Input
                          value={item.initiative}
                          onChange={(e) => setItem(item.id, { initiative: e.target.value })}
                          onClick={(e) => e.stopPropagation()}
                          className="h-8"
                        />
                      )}
                    </TableCell>
                    <TableCell>
                      {isLocked ? (
                        <Badge variant="outline" className="capitalize">{item.dimension}</Badge>
                      ) : (
                        <Select value={item.dimension} onValueChange={(v) => setItem(item.id, { dimension: v as ActionItem["dimension"] })}>
                          <SelectTrigger className="h-8 w-32 capitalize"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {Object.values(Dimension).map((d) => (
                              <SelectItem key={d} value={d} className="capitalize">{d}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </TableCell>
                    <TableCell>
                      {isLocked ? (
                        <Badge variant="secondary" className="font-mono bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 border-0">
                          {item.effort}
                        </Badge>
                      ) : (
                        <Select
                          value={item.effort}
                          onValueChange={(v) => {
                            const newEffort = v as ActionItemEffort;
                            const patch: Partial<ActionItem> = { effort: newEffort };
                            // If the assessor hasn't set a manual override, the formula
                            // display updates automatically (costEstimate stays null/undefined).
                            // If they DID override, clear it when effort changes so the new
                            // effort's formula applies (they can re-override if needed).
                            if (item.costEstimate != null) {
                              // Clear the stored override so the new effort's formula applies.
                              patch.costEstimate = undefined;
                            }
                            setItem(item.id, patch);
                          }}
                        >
                          <SelectTrigger className="h-8 w-16 font-mono"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {SIZES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      )}
                    </TableCell>
                    <TableCell>
                      {isLocked ? (
                        <Badge variant="secondary" className="font-mono bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300 border-0">
                          {item.impact}
                        </Badge>
                      ) : (
                        <Select value={item.impact} onValueChange={(v) => setItem(item.id, { impact: v as ActionItemImpact })}>
                          <SelectTrigger className="h-8 w-16 font-mono"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {SIZES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {isLocked ? (
                        <div className="truncate" title={item.ownerRole || "Unassigned"}>
                          {item.ownerRole || "Unassigned"}
                        </div>
                      ) : (
                        <Input
                          value={item.ownerRole ?? ""}
                          onChange={(e) => setItem(item.id, { ownerRole: e.target.value })}
                          onClick={(e) => e.stopPropagation()}
                          placeholder="Owner role"
                          className="h-8"
                        />
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {isLocked ? (
                        <div className="truncate" title={item.successMetric || "—"}>
                          {item.successMetric || "—"}
                        </div>
                      ) : (
                        <div className="truncate" title={item.successMetric || ""}>
                          {item.successMetric || (
                            <span className="text-muted-foreground/60">Click to add a success metric…</span>
                          )}
                        </div>
                      )}
                    </TableCell>
                    {!isLocked && (
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeItem(item.id);
                          }}
                          className="h-8 w-8 p-0 text-muted-foreground"
                          aria-label="Remove row"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                  {isExpanded && (
                    <TableRow
                      id={panelId}
                      role="region"
                      aria-label="Initiative details"
                      className="bg-muted/30 hover:bg-muted/30"
                    >
                      <TableCell colSpan={totalColumns} className="p-0">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 p-6">
                          <div className="space-y-2">
                            <label
                              htmlFor={`${panelId}-initiative`}
                              className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                            >
                              Initiative
                            </label>
                            {isLocked ? (
                              <p
                                id={`${panelId}-initiative`}
                                className="text-sm text-foreground whitespace-pre-wrap break-words leading-relaxed"
                              >
                                {item.initiative || "—"}
                              </p>
                            ) : (
                              <Textarea
                                id={`${panelId}-initiative`}
                                value={item.initiative}
                                onChange={(e) => setItem(item.id, { initiative: e.target.value })}
                                className="min-h-[120px] resize-y"
                                placeholder="Describe the initiative…"
                              />
                            )}
                          </div>
                          <div className="space-y-2">
                            <label
                              htmlFor={`${panelId}-success-metric`}
                              className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                            >
                              Success metric
                            </label>
                            {isLocked ? (
                              <p
                                id={`${panelId}-success-metric`}
                                className="text-sm text-foreground whitespace-pre-wrap break-words leading-relaxed"
                              >
                                {item.successMetric || "—"}
                              </p>
                            ) : (
                              <Textarea
                                id={`${panelId}-success-metric`}
                                value={item.successMetric ?? ""}
                                onChange={(e) => setItem(item.id, { successMetric: e.target.value })}
                                className="min-h-[120px] resize-y"
                                placeholder="How will success be measured?"
                              />
                            )}
                          </div>
                          {/* FullStack cost estimate */}
                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <label
                                htmlFor={`${panelId}-cost-estimate`}
                                className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                              >
                                FullStack cost estimate
                                {item.costEstimate != null && (
                                  <span className="ml-1.5 text-amber-600 dark:text-amber-400">(overridden)</span>
                                )}
                              </label>
                              {!isLocked && item.costEstimate != null && (
                                <button
                                  type="button"
                                  onClick={() => setItem(item.id, { costEstimate: undefined })}
                                  className="text-xs text-muted-foreground hover:text-foreground underline"
                                >
                                  Reset to formula
                                </button>
                              )}
                            </div>
                            {isLocked ? (
                              <p className="text-sm text-foreground font-mono">
                                ${(item.costEstimate ?? EFFORT_HOURS[item.effort] * currentRate).toLocaleString()}
                                {item.costEstimate == null && <span className="text-muted-foreground ml-1">(formula)</span>}
                              </p>
                            ) : (
                              <div className="relative">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                                <Input
                                  id={`${panelId}-cost-estimate`}
                                  type="number"
                                  min={0}
                                  step={1000}
                                  value={item.costEstimate ?? EFFORT_HOURS[item.effort] * currentRate}
                                  onChange={(e) => {
                                    const n = Number(e.target.value);
                                    if (Number.isFinite(n)) {
                                      const formulaDefault = EFFORT_HOURS[item.effort] * currentRate;
                                      // Store as override only if it differs from the current formula default
                                      setItem(item.id, { costEstimate: n === formulaDefault ? undefined : n });
                                    }
                                  }}
                                  className="pl-7 font-mono"
                                />
                              </div>
                            )}
                            <p className="text-xs text-muted-foreground">
                              FullStack's estimated delivery cost. Pre-filled from effort × ${currentRate}/hr (from Business Case); adjust as needed.
                            </p>
                          </div>
                          {/* Value lever */}
                          <div className="space-y-2">
                            <label
                              htmlFor={`${panelId}-value-lever`}
                              className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                            >
                              Value lever
                            </label>
                            {isLocked ? (
                              <p className="text-sm text-foreground">
                                {item.valueLever ? (VALUE_LEVER_LABELS[item.valueLever] ?? item.valueLever) : "None"}
                              </p>
                            ) : (
                              <Select
                                value={item.valueLever ?? "none"}
                                onValueChange={(v) =>
                                  setItem(item.id, {
                                    valueLever: v === "none" ? undefined : (v as ActionItem["valueLever"]),
                                  })
                                }
                              >
                                <SelectTrigger id={`${panelId}-value-lever`} className="w-full">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="none">None</SelectItem>
                                  <SelectItem value="cycle_time">Cycle Time Reduction</SelectItem>
                                  <SelectItem value="rework">Rework Reduction</SelectItem>
                                  <SelectItem value="review">Code Review Acceleration</SelectItem>
                                  <SelectItem value="onboarding">Onboarding Acceleration</SelectItem>
                                  <SelectItem value="test_quality">Test Coverage & Quality</SelectItem>
                                  <SelectItem value="mttr">Incident Resolution (MTTR)</SelectItem>
                                </SelectContent>
                              </Select>
                            )}
                            <p className="text-xs text-muted-foreground">
                              Which client benefit lever does this initiative primarily move?
                            </p>
                            {/* Expected impact — shown when a lever is selected */}
                            {item.valueLever && (
                              <div className="space-y-2 pt-2 border-t mt-2">
                                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                  Expected impact
                                </label>
                                {isLocked ? (
                                  <p className="text-sm text-foreground font-mono">
                                    {item.expectedImpact != null
                                      ? `${(item.expectedImpact * 100).toFixed(0)}%`
                                      : "—"}
                                  </p>
                                ) : (
                                  <div className="space-y-2">
                                    <div className="flex gap-2">
                                      {IMPACT_PRESETS.map((preset) => (
                                        <Button
                                          key={preset.label}
                                          type="button"
                                          size="sm"
                                          variant={item.expectedImpact === preset.value ? "default" : "outline"}
                                          onClick={() => setItem(item.id, { expectedImpact: preset.value })}
                                          className="text-xs"
                                        >
                                          {preset.label} ({(preset.value * 100).toFixed(0)}%)
                                        </Button>
                                      ))}
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs text-muted-foreground">Custom:</span>
                                      <div className="relative w-24">
                                        <Input
                                          type="number"
                                          min={0}
                                          max={100}
                                          step={1}
                                          value={
                                            item.expectedImpact != null
                                              ? Number((item.expectedImpact * 100).toFixed(1))
                                              : ""
                                          }
                                          placeholder="0"
                                          onChange={(e) => {
                                            const pct = Number(e.target.value);
                                            if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
                                              setItem(item.id, { expectedImpact: pct / 100 });
                                            }
                                          }}
                                          className="pr-6 font-mono text-sm"
                                        />
                                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">%</span>
                                      </div>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
