import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
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

const PRIORITY_RANK: Record<ActionItemPriority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
};

// Each step down in priority order shifts the bar one week to the right so
// higher-priority items visibly start sooner while still allowing overlap.
const STAGGER_WEEKS = 1;
// Minimum bar density so a long timeline (many weeks) still gets a horizontal
// scroll instead of squishing every label to nothing. The actual pixels-per-
// week used at render time is computed responsively from the container width
// so that short timelines stretch to fill the whole panel instead of leaving
// the right half blank.
const MIN_PIXELS_PER_WEEK = 22;

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

function ActionPlanTimeline({ items }: { items: ActionItem[] }) {
  const today = useMemo(() => new Date(), []);
  const derived = useMemo(() => deriveTimeline(items), [items]);
  const totalWeeks = useMemo(() => {
    const max = derived.reduce((acc, d) => Math.max(acc, d.startWeek + d.widthWeeks), 0);
    // Always show at least 8 weeks of runway so the axis is never lonely.
    return Math.max(max, 8);
  }, [derived]);
  const months = useMemo(() => buildMonthSegments(totalWeeks, today), [totalWeeks, today]);

  // Measure the scroll container so pixels-per-week stretches to fill the
  // available width when the timeline is short, and falls back to the minimum
  // (with horizontal scroll) when it would otherwise crush the labels. We
  // intentionally observe the wrapping div, not the inner grid, because the
  // inner grid's width is what we're computing.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pixelsPerWeek = useMemo(() => {
    if (containerWidth <= 0 || totalWeeks <= 0) return MIN_PIXELS_PER_WEEK;
    return Math.max(MIN_PIXELS_PER_WEEK, containerWidth / totalWeeks);
  }, [containerWidth, totalWeeks]);

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

  const widthPx = totalWeeks * pixelsPerWeek;

  return (
    <div className="mb-6 border rounded-md shadow-sm bg-card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
        <h3 className="text-sm font-semibold text-foreground">Approximate timeline</h3>
        <span className="text-xs text-muted-foreground">
          {derived.length} {derived.length === 1 ? "initiative" : "initiatives"} · ~{totalWeeks} weeks
        </span>
      </div>
      <div ref={scrollRef} className="overflow-x-auto">
        <div style={{ width: `${widthPx}px`, minWidth: "100%" }}>
          <div className="flex border-b">
            {months.map((m, i) => (
              <div
                key={`${m.label}-${i}`}
                style={{ width: `${m.weeks * pixelsPerWeek}px` }}
                className="px-2 py-1 text-xs font-medium text-muted-foreground border-r last:border-r-0 bg-muted/20"
              >
                {m.label}
              </div>
            ))}
          </div>
          <div className="flex border-b">
            {Array.from({ length: totalWeeks }).map((_, w) => (
              <div
                key={w}
                style={{ width: `${pixelsPerWeek}px` }}
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
                        left: `${startWeek * pixelsPerWeek}px`,
                        width: `${Math.max(widthWeeks * pixelsPerWeek, 16)}px`,
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

      <ActionPlanTimeline items={items} />

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
                        <Select value={item.effort} onValueChange={(v) => setItem(item.id, { effort: v as ActionItemEffort })}>
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
