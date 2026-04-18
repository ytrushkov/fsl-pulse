import { useState } from "react";
import { useParams } from "wouter";
import { useListConnectors, useDeleteConnector, getListConnectorsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Database, RefreshCw, Trash2, Play, Settings } from "lucide-react";
import { CreateConnectorDialog } from "@/components/connectors/create-connector-dialog";
import { formatRelative } from "@/lib/format";

export default function ConnectorsList() {
  const params = useParams();
  const id = params.id as string;
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const { data: connectors, isLoading } = useListConnectors(id, {
    query: { enabled: !!id, queryKey: getListConnectorsQueryKey(id) },
  });

  const deleteConnector = useDeleteConnector();

  const handleDelete = (connectorId: string) => {
    if (confirm("Are you sure you want to remove this connector?")) {
      deleteConnector.mutate({ connectorId }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListConnectorsQueryKey(id) });
        }
      });
    }
  };

  return (
    <AppLayout engagementId={id}>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Connectors</h1>
          <p className="text-muted-foreground mt-1">Manage automated data collection sources.</p>
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
          <CardDescription>Integrations currently extracting evidence for this engagement.</CardDescription>
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
                Add a connector to start automatically collecting evidence from your client's systems.
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
                  <TableHead>Last Run</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {connectors.map((connector) => (
                  <TableRow key={connector.id}>
                    <TableCell className="font-medium">{connector.label}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">{connector.kind.replace('_', ' ')}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge 
                        variant={
                          connector.status === 'collected' ? 'default' : 
                          connector.status === 'failed' ? 'destructive' : 'secondary'
                        }
                        className="capitalize"
                      >
                        {connector.status.replace('_', ' ')}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {connector.lastRunAt ? formatRelative(connector.lastRunAt) : 'Never'}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="icon" title="Run extraction">
                          <Play className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" title="Configure">
                          <Settings className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => handleDelete(connector.id)} title="Remove">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </AppLayout>
  );
}
