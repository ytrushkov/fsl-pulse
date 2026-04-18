import { useState } from "react";
import { useParams } from "wouter";
import {
  useListConnectors,
  useDeleteConnector,
  useRunConnector,
  getListConnectorsQueryKey,
  type Connector,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Plus,
  Database,
  Trash2,
  Play,
  Settings,
  AlertCircle,
  Eye,
  Clock,
  History,
} from "lucide-react";
import { CreateConnectorDialog } from "@/components/connectors/create-connector-dialog";
import { EditConnectorDialog } from "@/components/connectors/edit-connector-dialog";
import { SignalsDrawer } from "@/components/connectors/signals-drawer";
import { RunHistoryDialog } from "@/components/connectors/run-history-dialog";
import { useToast } from "@/hooks/use-toast";
import { formatRelative } from "@/lib/format";

// Freshness thresholds (hours since last successful run). Tuned to surface a
// stale connector before scoring is materially out of date.
const FRESH_HOURS = 12;
const STALE_HOURS = 36;

type Freshness = "fresh" | "aging" | "stale" | "never";

function freshnessOf(lastSuccessAt: string | null | undefined): Freshness {
  if (!lastSuccessAt) return "never";
  const ageHours = (Date.now() - new Date(lastSuccessAt).getTime()) / 3_600_000;
  if (ageHours < FRESH_HOURS) return "fresh";
  if (ageHours < STALE_HOURS) return "aging";
  return "stale";
}

function FreshnessBadge({ connector }: { connector: Connector }) {
  const f = freshnessOf(connector.lastSuccessAt);
  const variant: "default" | "secondary" | "destructive" | "outline" =
    f === "fresh"
      ? "default"
      : f === "aging"
        ? "secondary"
        : f === "stale"
          ? "destructive"
          : "outline";
  const label =
    f === "fresh"
      ? "Fresh"
      : f === "aging"
        ? "Aging"
        : f === "stale"
          ? "Stale"
          : "No data";
  const tip = connector.lastSuccessAt
    ? `Last successful run ${formatRelative(connector.lastSuccessAt)}`
    : "Never run successfully";
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant={variant} className="cursor-help">
            {label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{tip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export default function ConnectorsList() {
  const params = useParams();
  const id = params.id as string;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Connector | null>(null);
  const [signalsFor, setSignalsFor] = useState<Connector | null>(null);
  const [historyFor, setHistoryFor] = useState<Connector | null>(null);

  const { data: connectors, isLoading } = useListConnectors(id, {
    query: { enabled: !!id, queryKey: getListConnectorsQueryKey(id) },
  });

  const deleteConnector = useDeleteConnector();
  const runConnector = useRunConnector();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListConnectorsQueryKey(id) });
  };

  const handleDelete = (connectorId: string) => {
    if (!confirm("Remove this connector? Collected evidence will be kept."))
      return;
    deleteConnector.mutate(
      { connectorId },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Connector removed" });
        },
      },
    );
  };

  const handleRun = (c: Connector) => {
    runConnector.mutate(
      { connectorId: c.id },
      {
        onSuccess: () => {
          invalidate();
          toast({
            title: `Run started for ${c.label}`,
            description: "Refresh in a moment to see updated signals.",
          });
        },
        onError: (err) => {
          toast({
            variant: "destructive",
            title: "Run failed",
            description: err instanceof Error ? err.message : "Unknown error",
          });
        },
      },
    );
  };

  return (
    <AppLayout engagementId={id}>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Connectors</h1>
          <p className="text-muted-foreground mt-1">
            Manage automated data collection sources.
          </p>
        </div>
        <CreateConnectorDialog
          engagementId={id}
          open={isCreateOpen}
          onOpenChange={setIsCreateOpen}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Configured Connectors</CardTitle>
          <CardDescription>
            Integrations currently extracting evidence for this engagement.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : !connectors || connectors.length === 0 ? (
            <div className="text-center py-12 border rounded bg-muted/20 border-dashed">
              <Database className="h-8 w-8 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">No Connectors Found</h3>
              <p className="text-muted-foreground mb-4 max-w-sm mx-auto">
                Add a connector to start automatically collecting evidence from
                your client's systems.
              </p>
              <Button onClick={() => setIsCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" /> Add Connector
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Freshness</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Last Run</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {connectors.map((connector) => {
                  const isRunning =
                    runConnector.isPending &&
                    runConnector.variables?.connectorId === connector.id;
                  return (
                    <TableRow key={connector.id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          {connector.label}
                          {connector.lastError ? (
                            <TooltipProvider delayDuration={200}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <AlertCircle className="h-4 w-4 text-destructive" />
                                </TooltipTrigger>
                                <TooltipContent className="max-w-xs">
                                  <p className="font-semibold mb-1">
                                    Last error
                                  </p>
                                  <p className="text-xs break-words">
                                    {connector.lastError}
                                  </p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="capitalize">
                          {connector.kind.replace("_", " ")}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            connector.status === "collected"
                              ? "default"
                              : connector.status === "failed"
                                ? "destructive"
                                : "secondary"
                          }
                          className="capitalize"
                        >
                          {connector.status.replace("_", " ")}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <FreshnessBadge connector={connector} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {connector.scheduleEnabled ? (
                          <div className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {cadenceLabel(connector.scheduleCadenceMinutes)}
                          </div>
                        ) : (
                          <span className="text-muted-foreground/70">Off</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {connector.lastRunAt
                          ? formatRelative(connector.lastRunAt)
                          : "Never"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            title="View raw signals"
                            onClick={() => setSignalsFor(connector)}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Run history"
                            onClick={() => setHistoryFor(connector)}
                          >
                            <History className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Run now"
                            disabled={isRunning}
                            onClick={() => handleRun(connector)}
                          >
                            <Play className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Configure"
                            onClick={() => setEditing(connector)}
                          >
                            <Settings className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive hover:text-destructive hover:bg-destructive/10"
                            onClick={() => handleDelete(connector.id)}
                            title="Remove"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <EditConnectorDialog
        connector={editing}
        engagementId={id}
        open={Boolean(editing)}
        onOpenChange={(o) => !o && setEditing(null)}
      />
      <SignalsDrawer
        connectorId={signalsFor?.id ?? null}
        connectorLabel={signalsFor?.label ?? ""}
        open={Boolean(signalsFor)}
        onOpenChange={(o) => !o && setSignalsFor(null)}
      />
    </AppLayout>
  );
}

function cadenceLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  if (minutes < 10080) return `${Math.round(minutes / 1440)}d`;
  return `${Math.round(minutes / 10080)}w`;
}
