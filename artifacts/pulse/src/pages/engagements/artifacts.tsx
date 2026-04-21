import { useState, useRef, useCallback } from "react";
import { useParams } from "wouter";
import {
  useListArtifacts,
  useCreateArtifact,
  useDeleteArtifactDoc,
  getListArtifactsQueryKey,
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
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Files,
  Upload,
  Trash2,
  FileText,
  Download,
  X,
  FileType,
} from "lucide-react";
import { formatRelative } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@clerk/react";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const ACCEPTED_MIME = [
  ".pdf",
  ".txt",
  ".md",
  ".markdown",
  ".docx",
  ".pptx",
  "application/pdf",
  "text/plain",
  "text/markdown",
  DOCX_MIME,
  PPTX_MIME,
].join(",");
const MAX_BYTES = 25 * 1024 * 1024;

function formatBytes(n: number): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  // Chunk the conversion so we don't blow the call stack on large PDFs.
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK) as unknown as number[],
    );
  }
  return btoa(binary);
}

async function extractPdfText(buf: ArrayBuffer): Promise<string> {
  // Lazy-load pdfjs only when needed so the rest of the app stays light.
  const pdfjs = await import("pdfjs-dist");
  // Worker URL: ship the module worker via Vite's ?url import so it works in
  // both dev and prod bundles without extra config.
  const workerSrc = (
    await import("pdfjs-dist/build/pdf.worker.min.mjs?url")
  ).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const text = tc.items
      .map((it) => ("str" in it ? (it as { str: string }).str : ""))
      .join(" ");
    pages.push(text);
  }
  return pages.join("\n\n").trim();
}

type StagedFile = {
  file: File;
  mimeType: string;
  dataBase64: string;
  extractedText: string;
};

export default function ArtifactsView() {
  const params = useParams();
  const id = params.id as string;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { getToken } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [filename, setFilename] = useState("");
  const [kind, setKind] = useState("architecture");
  const [content, setContent] = useState("");
  const [staged, setStaged] = useState<StagedFile | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const { data: artifacts, isLoading } = useListArtifacts(id, {
    query: { enabled: !!id, queryKey: getListArtifactsQueryKey(id) },
  });

  const createArtifact = useCreateArtifact();
  const deleteArtifact = useDeleteArtifactDoc();

  const handleFile = useCallback(
    async (file: File) => {
      if (file.size > MAX_BYTES) {
        toast({
          variant: "destructive",
          title: "File too large",
          description: `Max size is ${MAX_BYTES / (1024 * 1024)} MB.`,
        });
        return;
      }
      setIsProcessing(true);
      try {
        const buf = await file.arrayBuffer();
        const lname = file.name.toLowerCase();
        const isPdf =
          file.type === "application/pdf" || lname.endsWith(".pdf");
        const isMarkdown =
          file.type === "text/markdown" ||
          lname.endsWith(".md") ||
          lname.endsWith(".markdown");
        const isDocx =
          file.type === DOCX_MIME || lname.endsWith(".docx");
        const isPptx =
          file.type === PPTX_MIME || lname.endsWith(".pptx");
        let mime: string;
        let extractedText = "";
        // For text/markdown there's no value in shipping a separate base64
        // copy — the extracted content IS the file. Skipping the binary
        // also keeps us comfortably under the 40MB JSON body limit since
        // base64 inflates payload by ~33%.
        let dataBase64 = "";
        if (isPdf) {
          mime = "application/pdf";
          dataBase64 = arrayBufferToBase64(buf);
          try {
            extractedText = await extractPdfText(buf);
          } catch (err) {
            console.warn("PDF text extraction failed", err);
            extractedText = `[PDF: ${file.name} — text extraction failed, original file still attached]`;
          }
        } else if (isDocx || isPptx) {
          // Office docs are extracted server-side (mammoth for .docx, an
          // OOXML scrape for .pptx) so we don't have to ship those parsers
          // — and their fonts/workers — into the browser bundle.
          mime = isDocx ? DOCX_MIME : PPTX_MIME;
          dataBase64 = arrayBufferToBase64(buf);
          extractedText = "";
        } else {
          mime = isMarkdown ? "text/markdown" : "text/plain";
          extractedText = new TextDecoder().decode(buf);
        }
        setStaged({ file, mimeType: mime, dataBase64, extractedText });
        if (!filename) setFilename(file.name);
        setContent(extractedText);
      } catch (err) {
        console.error(err);
        toast({
          variant: "destructive",
          title: "Could not read file",
          description: err instanceof Error ? err.message : "Unknown error",
        });
      } finally {
        setIsProcessing(false);
      }
    },
    [toast, filename],
  );

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void handleFile(f);
    e.target.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void handleFile(f);
  };

  const clearStaged = () => {
    setStaged(null);
    setContent("");
  };

  const handleUpload = () => {
    // For docx/pptx the server extracts text after upload, so an empty
    // `content` is legitimate as long as we have a binary to hand it.
    const hasServerExtractable =
      staged?.mimeType === DOCX_MIME || staged?.mimeType === PPTX_MIME;
    if (!filename) return;
    if (!content && !hasServerExtractable) return;
    createArtifact.mutate(
      {
        id,
        data: {
          filename,
          kind,
          content,
          ...(staged
            ? {
                mimeType: staged.mimeType,
                // Only attach the binary when we actually have one (PDFs).
                // Text uploads round-trip via `content` alone.
                ...(staged.dataBase64
                  ? { dataBase64: staged.dataBase64 }
                  : {}),
              }
            : {}),
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListArtifactsQueryKey(id),
          });
          toast({
            title: "Artifact uploaded",
            description: staged
              ? `${staged.file.name} attached and indexed.`
              : "Successfully added artifact.",
          });
          setFilename("");
          setContent("");
          setStaged(null);
        },
        onError: (err: unknown) => {
          const msg =
            err && typeof err === "object" && "message" in err
              ? String((err as { message?: string }).message)
              : "Failed to upload artifact.";
          toast({
            variant: "destructive",
            title: "Upload failed",
            description: msg,
          });
        },
      },
    );
  };

  const handleDelete = (artifactId: string) => {
    if (!confirm("Are you sure you want to delete this artifact?")) return;
    deleteArtifact.mutate(
      { artifactId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListArtifactsQueryKey(id),
          });
        },
      },
    );
  };

  const handleDownload = async (artifactId: string, filename: string) => {
    // Fetch the binary directly with the Clerk bearer token, then trigger a
    // download via an object URL — simpler than opening a new tab and lets us
    // honor the bearer-token auth path that bypasses cookies in the iframe.
    try {
      const token = await getToken().catch(() => null);
      const res = await fetch(`/api/artifacts/${artifactId}/download`, {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Download failed",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  return (
    <AppLayout engagementId={id}>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Artifacts</h1>
          <p className="text-muted-foreground mt-1">
            Upload architecture docs, process guidelines, and strategy memos.
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <Card>
            <CardHeader>
              <CardTitle>Upload Artifact</CardTitle>
              <CardDescription>
                Drop a PDF, Word doc, slide deck, or text file — or paste content below.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* File picker / drop zone. PDFs are parsed in-browser so the
                  extracted text becomes the searchable evidence content while
                  the original file is preserved for download. */}
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`relative rounded-md border-2 border-dashed p-6 text-center cursor-pointer transition-colors ${
                  isDragging
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/60 hover:bg-muted/30"
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED_MIME}
                  className="hidden"
                  onChange={handleFileInput}
                />
                {staged ? (
                  <div className="flex items-center justify-between gap-3 text-left">
                    <div className="flex items-center gap-3 min-w-0">
                      <FileType className="h-8 w-8 text-primary shrink-0" />
                      <div className="min-w-0">
                        <div className="font-medium truncate">
                          {staged.file.name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatBytes(staged.file.size)} · {staged.mimeType}
                        </div>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        clearStaged();
                      }}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ) : isProcessing ? (
                  <div className="text-sm text-muted-foreground">
                    Reading file…
                  </div>
                ) : (
                  <>
                    <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                    <div className="text-sm font-medium">
                      Drop a file or click to browse
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      PDF, DOCX, PPTX, TXT, MD · up to 25 MB
                    </div>
                  </>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="filename">Filename / Title</Label>
                <Input
                  id="filename"
                  value={filename}
                  onChange={(e) => setFilename(e.target.value)}
                  placeholder="e.g. Q3_Architecture_Review.pdf"
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
                <Label htmlFor="content">
                  Extracted Content
                  {staged ? (
                    <span className="ml-2 text-xs text-muted-foreground font-normal">
                      {staged.mimeType === DOCX_MIME ||
                      staged.mimeType === PPTX_MIME
                        ? "(extracted on the server after upload)"
                        : "(auto-extracted, editable)"}
                    </span>
                  ) : null}
                </Label>
                <Textarea
                  id="content"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder={
                    staged?.mimeType === DOCX_MIME ||
                    staged?.mimeType === PPTX_MIME
                      ? "Leave blank — text will be extracted from the file after upload."
                      : "Paste document text here, or drop a file above…"
                  }
                  className="min-h-[160px] font-mono text-sm"
                />
              </div>
              <Button
                className="w-full"
                onClick={handleUpload}
                disabled={
                  createArtifact.isPending ||
                  !filename ||
                  isProcessing ||
                  (!content &&
                    staged?.mimeType !== DOCX_MIME &&
                    staged?.mimeType !== PPTX_MIME)
                }
              >
                {createArtifact.isPending ? (
                  "Uploading…"
                ) : (
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
              <CardDescription>
                Documents currently available as evidence sources.
              </CardDescription>
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
                  <h3 className="text-lg font-medium mb-2">
                    No Artifacts Found
                  </h3>
                  <p className="text-muted-foreground max-w-sm mx-auto">
                    Upload documents to have them automatically processed and
                    available as evidence.
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Document</TableHead>
                      <TableHead>Kind</TableHead>
                      <TableHead>Size</TableHead>
                      <TableHead>Summary</TableHead>
                      <TableHead>Uploaded</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {artifacts.map((artifact) => (
                      <TableRow key={artifact.id}>
                        <TableCell
                          className="font-medium max-w-[180px] truncate"
                          title={artifact.filename}
                        >
                          <div className="flex items-center gap-2">
                            <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                            <span className="truncate">
                              {artifact.filename}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className="capitalize">
                            {artifact.kind}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                          {formatBytes(artifact.sizeBytes ?? 0)}
                        </TableCell>
                        <TableCell
                          className="text-sm text-muted-foreground max-w-[250px] truncate"
                          title={artifact.extractedSummary}
                        >
                          {artifact.extractedSummary || "Processing..."}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                          {formatRelative(artifact.createdAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() =>
                              handleDownload(artifact.id, artifact.filename)
                            }
                            title="Download original"
                          >
                            <Download className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive hover:text-destructive hover:bg-destructive/10"
                            onClick={() => handleDelete(artifact.id)}
                            title="Delete"
                          >
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
