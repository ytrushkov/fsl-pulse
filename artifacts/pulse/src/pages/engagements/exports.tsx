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
import { formatRelative } from "@/lib/format";
import { Download, Package, FileArchive, FileText, FileCode, FileBox } from "lucide-react";

const BASE_URL = (import.meta as any).env?.BASE_URL ?? "/";

function fileIcon(name: string) {
  if (name.endsWith(".pdf")) return <FileText className="h-4 w-4" />;
  if (name.endsWith(".docx")) return <FileBox className="h-4 w-4" />;
  if (name.endsWith(".json")) return <FileCode className="h-4 w-4" />;
  return <Download className="h-4 w-4" />;
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

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
          toast({ title: "Export created", description: "Branded PDF + DOCX bundle is ready." });
        },
        onError: () => {
          toast({ variant: "destructive", title: "Error", description: "Failed to create export bundle." });
        },
      },
    );
  };

  return (
    <AppLayout engagementId={id}>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Exports</h1>
          <p className="text-muted-foreground mt-1">Immutable, signed snapshots of the deliverables for client handoff.</p>
        </div>
        <Button onClick={handleCreate} disabled={createExport.isPending} className="gap-2">
          <Package className="h-4 w-4" />
          {createExport.isPending ? "Compiling..." : "Create Bundle"}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Generated Bundles</CardTitle>
          <CardDescription>Each bundle ships as a branded PDF, an editable DOCX, and a signed JSON snapshot.</CardDescription>
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
                  <TableHead>Finalized by</TableHead>
                  <TableHead>Signature (SHA-256)</TableHead>
                  <TableHead>Files</TableHead>
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
                    <TableCell className="text-sm text-muted-foreground">
                      {exp.finalizerEmail ?? <span className="italic">unknown</span>}
                    </TableCell>
                    <TableCell>
                      <code className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded truncate max-w-[200px] inline-block" title={exp.signature ?? ""}>
                        {exp.signature ? `${exp.signature.slice(0, 16)}…` : "Pending..."}
                      </code>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1.5">
                        {(exp.files ?? []).map((f) => (
                          <Button
                            key={f.name}
                            asChild
                            size="sm"
                            variant="outline"
                            className="gap-1.5 h-7 px-2 text-xs"
                          >
                            <a
                              href={`${BASE_URL}api/engagements/${id}/exports/${exp.id}/file/${encodeURIComponent(f.name)}`}
                              download={f.name}
                            >
                              {fileIcon(f.name)}
                              <span className="font-mono">{f.name.split(".").pop()?.toUpperCase()}</span>
                              <span className="text-muted-foreground">{formatBytes(f.sizeBytes)}</span>
                            </a>
                          </Button>
                        ))}
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
