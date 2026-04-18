import { useState } from "react";
import { useParams } from "wouter";
import { useListArtifacts, useCreateArtifact, useDeleteArtifactDoc, getListArtifactsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Files, Upload, Trash2, FileText } from "lucide-react";
import { formatRelative } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";

export default function ArtifactsView() {
  const params = useParams();
  const id = params.id as string;
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [filename, setFilename] = useState("");
  const [kind, setKind] = useState("architecture");
  const [content, setContent] = useState("");

  const { data: artifacts, isLoading } = useListArtifacts(id, {
    query: { enabled: !!id, queryKey: getListArtifactsQueryKey(id) },
  });

  const createArtifact = useCreateArtifact();
  const deleteArtifact = useDeleteArtifactDoc();

  const handleUpload = () => {
    if (!filename || !content) return;

    createArtifact.mutate(
      { id, data: { filename, kind, content } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListArtifactsQueryKey(id) });
          toast({ title: "Artifact uploaded", description: "Successfully added artifact." });
          setFilename("");
          setContent("");
        },
        onError: () => {
          toast({ variant: "destructive", title: "Error", description: "Failed to upload artifact." });
        }
      }
    );
  };

  const handleDelete = (artifactId: string) => {
    if (confirm("Are you sure you want to delete this artifact?")) {
      deleteArtifact.mutate({ artifactId }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListArtifactsQueryKey(id) });
        }
      });
    }
  };

  return (
    <AppLayout engagementId={id}>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Artifacts</h1>
          <p className="text-muted-foreground mt-1">Upload architecture docs, process guidelines, and strategy memos.</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <Card>
            <CardHeader>
              <CardTitle>Upload Artifact</CardTitle>
              <CardDescription>Paste document content for analysis.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="filename">Filename / Title</Label>
                <Input 
                  id="filename" 
                  value={filename} 
                  onChange={(e) => setFilename(e.target.value)} 
                  placeholder="e.g. Q3_Architecture_Review.md" 
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="kind">Document Kind</Label>
                <Input 
                  id="kind" 
                  value={kind} 
                  onChange={(e) => setKind(e.target.value)} 
                  placeholder="e.g. architecture, strategy, process" 
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="content">Content</Label>
                <Textarea 
                  id="content" 
                  value={content} 
                  onChange={(e) => setContent(e.target.value)} 
                  placeholder="Paste document text here..."
                  className="min-h-[200px] font-mono text-sm"
                />
              </div>
              <Button 
                className="w-full" 
                onClick={handleUpload} 
                disabled={createArtifact.isPending || !filename || !content}
              >
                {createArtifact.isPending ? "Uploading..." : (
                  <>
                    <Upload className="mr-2 h-4 w-4" /> Upload
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-2">
          <Card className="h-full">
            <CardHeader>
              <CardTitle>Collected Artifacts</CardTitle>
              <CardDescription>Documents currently available as evidence sources.</CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="space-y-4">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : !artifacts || artifacts.length === 0 ? (
                <div className="text-center py-16 border rounded bg-muted/20 border-dashed h-full flex flex-col items-center justify-center">
                  <Files className="h-8 w-8 mx-auto text-muted-foreground mb-4" />
                  <h3 className="text-lg font-medium mb-2">No Artifacts Found</h3>
                  <p className="text-muted-foreground max-w-sm mx-auto">
                    Upload documents to have them automatically processed and available as evidence.
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Document</TableHead>
                      <TableHead>Kind</TableHead>
                      <TableHead>Summary</TableHead>
                      <TableHead>Uploaded</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {artifacts.map((artifact) => (
                      <TableRow key={artifact.id}>
                        <TableCell className="font-medium max-w-[150px] truncate" title={artifact.filename}>
                          <div className="flex items-center gap-2">
                            <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                            <span className="truncate">{artifact.filename}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className="capitalize">{artifact.kind}</Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground max-w-[250px] truncate" title={artifact.extractedSummary}>
                          {artifact.extractedSummary || "Processing..."}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                          {formatRelative(artifact.createdAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => handleDelete(artifact.id)} title="Delete">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}
