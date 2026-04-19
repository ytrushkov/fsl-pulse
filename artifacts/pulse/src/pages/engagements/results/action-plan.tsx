import { useEffect, useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import { Trash2, Plus } from "lucide-react";

const PRIORITIES = ["P0", "P1", "P2"] as const;
const SIZES = ["S", "M", "L", "XL"] as const;

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
  useEffect(() => {
    if (deliverables?.actionPlan) setItems(deliverables.actionPlan);
  }, [deliverables?.actionPlan]);

  if (!deliverables?.actionPlan) {
    return <div className="p-8 text-center text-muted-foreground">No action plan available.</div>;
  }

  const isLocked = deliverables.statuses.actionPlan === "locked";
  const dirty = JSON.stringify(items) !== JSON.stringify(deliverables.actionPlan);

  const setItem = (id: string, patch: Partial<ActionItem>) =>
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const removeItem = (id: string) => setItems((xs) => xs.filter((x) => x.id !== id));
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

      <div className="border rounded-md shadow-sm overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="w-24">Priority</TableHead>
              <TableHead>Initiative</TableHead>
              <TableHead>Dimension</TableHead>
              <TableHead className="w-20">Effort</TableHead>
              <TableHead className="w-20">Impact</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Success metric</TableHead>
              {!isLocked && <TableHead className="w-12" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id} className="bg-card align-top">
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
                    item.initiative
                  ) : (
                    <Input
                      value={item.initiative}
                      onChange={(e) => setItem(item.id, { initiative: e.target.value })}
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
                    item.ownerRole || "Unassigned"
                  ) : (
                    <Input
                      value={item.ownerRole ?? ""}
                      onChange={(e) => setItem(item.id, { ownerRole: e.target.value })}
                      placeholder="Owner role"
                      className="h-8"
                    />
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {isLocked ? (
                    item.successMetric || "—"
                  ) : (
                    <Input
                      value={item.successMetric ?? ""}
                      onChange={(e) => setItem(item.id, { successMetric: e.target.value })}
                      placeholder="Success metric"
                      className="h-8"
                    />
                  )}
                </TableCell>
                {!isLocked && (
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeItem(item.id)}
                      className="h-8 w-8 p-0 text-muted-foreground"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
