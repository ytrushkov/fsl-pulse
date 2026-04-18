import { useState } from "react";
import { useParams } from "wouter";
import { useListExports, useCreateExport, getListExportsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { formatRelative, formatNumber } from "@/lib/format";
import { Download, Package, FileArchive } from "lucide-react";

export default function ExportsView() {
  const params = useParams();
  const id = params.id as string;
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: exports, isLoading } = useListExports(id, {
    query: { enabled: !!id, queryKey: getListExportsQueryKey(id) },
  });

  const createExport = useCreateExport();

  const handleCreate = () => {
    createExport.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListExportsQueryKey(id) });
          toast({ title: "Export created", description: "Deliverable bundle has been compiled successfully." });
        },
        onError: () => {
          toast({ variant: "destructive", title: "Error", description: "Failed to create export bundle." });
        }
      }
    );
  };

  return (
    <AppLayout engagementId={id}>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Exports</h1>
          <p className="text-muted-foreground mt-1">Immutable snapshots of deliverables for client handoff.</p>
        </div>
        <Button onClick={handleCreate} disabled={createExport.isPending} className="gap-2">
          <Package className="h-4 w-4" />
          {createExport.isPending ? "Compiling..." : "Create Bundle"}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Generated Bundles</CardTitle>
          <CardDescription>Downloadable ZIP archives containing all deliverables and evidence.</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : !exports || exports.length === 0 ? (
            <div className="text-center py-16 border rounded bg-muted/20 border-dashed">
              <FileArchive className="h-10 w-10 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">No Exports Found</h3>
              <p className="text-muted-foreground mb-6 max-w-sm mx-auto">
                Generate an export bundle when your deliverables are locked and ready for the client.
              </p>
              <Button onClick={handleCreate} disabled={createExport.isPending} variant="outline">
                <Package className="mr-2 h-4 w-4" /> Create First Bundle
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Signature (SHA-256)</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="text-right">Download</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {exports.map((exp) => (
                  <TableRow key={exp.id}>
                    <TableCell>
                      <Badge variant="secondary" className="font-mono">v{exp.version}</Badge>
                    </TableCell>
                    <TableCell className="text-sm font-medium">
                      {formatRelative(exp.createdAt)}
                    </TableCell>
                    <TableCell>
                      <code className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded truncate max-w-[200px] inline-block">
                        {exp.signature || "Pending..."}
                      </code>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-muted-foreground">
                      {exp.files?.[0] ? `${(exp.files[0].sizeBytes / 1024 / 1024).toFixed(2)} MB` : '-'}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" className="gap-2 font-medium text-primary">
                        <Download className="h-4 w-4" /> ZIP
                      </Button>
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
