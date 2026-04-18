import { useState, useEffect, useRef } from "react";
import { useParams, Link } from "wouter";
import { 
  useGetInterview, 
  useUpdateInterview,
  useListInterviewEvidence,
  useAddInterviewEvidence,
  useSuggestInterviewTags,
  useDeleteEvidence,
  getGetInterviewQueryKey,
  getListInterviewEvidenceQueryKey,
  Dimension,
  SignalType
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { ChevronLeft, Save, Tag, Sparkles, Trash2, Plus } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";

export default function InterviewDetailView() {
  const params = useParams();
  const engagementId = params.id as string;
  const interviewId = params.interviewId as string;
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [notes, setNotes] = useState("");
  const initializedForId = useRef<string | null>(null);

  const { data: interview, isLoading } = useGetInterview(interviewId, {
    query: { enabled: !!interviewId, queryKey: getGetInterviewQueryKey(interviewId) },
  });

  const { data: evidence } = useListInterviewEvidence(interviewId, {
    query: { enabled: !!interviewId, queryKey: getListInterviewEvidenceQueryKey(interviewId) },
  });

  const updateInterview = useUpdateInterview();
  const deleteEvidence = useDeleteEvidence();

  useEffect(() => {
    if (interview && initializedForId.current !== interviewId) {
      initializedForId.current = interviewId;
      setNotes(interview.notes || "");
    }
  }, [interview, interviewId]);

  const handleSaveNotes = () => {
    updateInterview.mutate(
      { interviewId, data: { notes } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetInterviewQueryKey(interviewId) });
          toast({ title: "Notes saved" });
        }
      }
    );
  };

  const handleDeleteEvidence = (id: string) => {
    if(confirm("Remove this evidence?")) {
      deleteEvidence.mutate(
        { evidenceId: id },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListInterviewEvidenceQueryKey(interviewId) });
          }
        }
      );
    }
  };

  const [selection, setSelection] = useState("");
  const [tagDialogOpen, setTagDialogOpen] = useState(false);

  const handleMouseUp = () => {
    const text = window.getSelection()?.toString() || "";
    if (text.length > 5) {
      setSelection(text);
    }
  };

  if (isLoading) return (
    <AppLayout engagementId={engagementId}>
      <Skeleton className="h-10 w-48 mb-6" />
      <div className="grid grid-cols-2 gap-6 h-[70vh]">
        <Skeleton className="h-full w-full" />
        <Skeleton className="h-full w-full" />
      </div>
    </AppLayout>
  );

  return (
    <AppLayout engagementId={engagementId}>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Link href={`/engagements/${engagementId}/interviews`}>
            <Button variant="outline" size="icon"><ChevronLeft className="h-4 w-4" /></Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{interview?.interviewee}</h1>
            <p className="text-muted-foreground text-sm">{interview?.role}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="capitalize">{interview?.status}</Badge>
          <Button variant="outline" onClick={handleSaveNotes} disabled={updateInterview.isPending}>
            <Save className="mr-2 h-4 w-4" /> Save Notes
          </Button>
          <AISuggestTagsButton interviewId={interviewId} notes={notes} />
        </div>
      </div>

      <div className="grid md:grid-cols-5 gap-6 h-[calc(100vh-180px)]">
        {/* Editor Pane */}
        <Card className="md:col-span-3 flex flex-col h-full overflow-hidden">
          <CardContent className="flex-1 p-0 flex flex-col relative">
            <Textarea
              className="flex-1 w-full p-6 border-0 focus-visible:ring-0 resize-none text-lg leading-relaxed bg-transparent"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onMouseUp={handleMouseUp}
              placeholder="Record interview notes here. Select text to tag as evidence."
            />
            {selection && (
              <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-popover text-popover-foreground shadow-lg border p-2 rounded-lg flex items-center gap-3 z-10 animate-in slide-in-from-bottom-2">
                <span className="text-sm font-medium px-2 max-w-[200px] truncate">"{selection}"</span>
                <Button size="sm" onClick={() => setTagDialogOpen(true)}>
                  <Tag className="h-3.5 w-3.5 mr-1" /> Tag Evidence
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelection("")}>Cancel</Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Evidence Pane */}
        <Card className="md:col-span-2 flex flex-col h-full overflow-hidden bg-muted/10">
          <div className="p-4 border-b bg-card">
            <h3 className="font-semibold flex items-center justify-between">
              Extracted Evidence
              <Badge variant="secondary">{evidence?.length || 0}</Badge>
            </h3>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {!evidence || evidence.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground text-sm">
                <Tag className="h-8 w-8 mx-auto mb-2 opacity-50" />
                No evidence tagged yet. Select text in the notes to extract.
              </div>
            ) : (
              evidence.map(ev => (
                <div key={ev.id} className="bg-card p-3 rounded-md border shadow-sm text-sm group relative">
                  <div className="mb-2 italic text-muted-foreground">"{ev.text}"</div>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="capitalize text-[10px] py-0">{ev.dimension}</Badge>
                    <Badge variant="outline" className={`capitalize text-[10px] py-0 ${
                      ev.signalType === 'strength' ? 'text-green-600 border-green-200 bg-green-50' :
                      ev.signalType === 'gap' ? 'text-red-600 border-red-200 bg-red-50' : 
                      ev.signalType === 'risk' ? 'text-orange-600 border-orange-200 bg-orange-50' : ''
                    }`}>
                      {ev.signalType}
                    </Badge>
                  </div>
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className="absolute top-1 right-1 h-6 w-6 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive transition-opacity"
                    onClick={() => handleDeleteEvidence(ev.id)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      <AddEvidenceDialog 
        interviewId={interviewId} 
        open={tagDialogOpen} 
        onOpenChange={setTagDialogOpen} 
        initialText={selection} 
        onComplete={() => setSelection("")}
      />
    </AppLayout>
  );
}

function AddEvidenceDialog({ interviewId, open, onOpenChange, initialText, onComplete }: any) {
  const [dimension, setDimension] = useState<string>(Dimension.process);
  const [signalType, setSignalType] = useState<string>(SignalType.gap);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const addEvidence = useAddInterviewEvidence();

  const handleAdd = () => {
    addEvidence.mutate(
      { interviewId, data: { dimension: dimension as any, signalType: signalType as any, text: initialText } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListInterviewEvidenceQueryKey(interviewId) });
          toast({ title: "Evidence tagged" });
          onOpenChange(false);
          onComplete();
        }
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tag Evidence</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="p-3 bg-muted rounded-md text-sm italic border-l-4 border-primary">
            "{initialText}"
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Dimension</label>
              <Select value={dimension} onValueChange={setDimension}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.values(Dimension).map(d => <SelectItem key={d} value={d} className="capitalize">{d}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Signal</label>
              <Select value={signalType} onValueChange={setSignalType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.values(SignalType).map(s => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleAdd} disabled={addEvidence.isPending}>Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AISuggestTagsButton({ interviewId, notes }: { interviewId: string, notes: string }) {
  const [open, setOpen] = useState(false);
  const suggestTags = useSuggestInterviewTags();
  const addEvidence = useAddInterviewEvidence();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleSuggest = () => {
    suggestTags.mutate({ interviewId }, {
      onSuccess: () => setOpen(true),
      onError: () => toast({ variant: "destructive", title: "Error running AI suggestion" })
    });
  };

  const handleAccept = (suggestion: any, index: number) => {
    addEvidence.mutate(
      { interviewId, data: { dimension: suggestion.dimension, signalType: suggestion.signalType, text: suggestion.text, stageHint: suggestion.stageHint } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListInterviewEvidenceQueryKey(interviewId) });
          toast({ title: "Accepted suggestion" });
          // In a real app we'd remove it from the suggestions list in state
        }
      }
    );
  };

  return (
    <>
      <Button onClick={handleSuggest} disabled={suggestTags.isPending || !notes.trim()} className="bg-indigo-600 hover:bg-indigo-700 text-white border-indigo-600">
        <Sparkles className="mr-2 h-4 w-4" /> AI Suggest Tags
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>AI Suggestions</DialogTitle>
            <DialogDescription>Review auto-extracted evidence from your notes.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {!suggestTags.data?.suggestions.length ? (
              <p className="text-center text-muted-foreground py-8">No significant evidence found.</p>
            ) : (
              suggestTags.data.suggestions.map((sug: any, i: number) => (
                <div key={i} className="border rounded-md p-4 bg-card shadow-sm">
                  <div className="mb-2 text-lg">"{sug.text}"</div>
                  <div className="flex items-center gap-2 mb-3">
                    <Badge variant="secondary" className="capitalize">{sug.dimension}</Badge>
                    <Badge variant="outline" className="capitalize">{sug.signalType}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground mb-4">{sug.rationale}</p>
                  <Button size="sm" onClick={() => handleAccept(sug, i)} className="w-full gap-2">
                    <Plus className="h-4 w-4" /> Accept & Tag
                  </Button>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
