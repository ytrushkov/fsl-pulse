import { useState } from "react";
import { Link, useParams, useLocation } from "wouter";
import { 
  useListInterviews, 
  useCreateInterview,
  useDeleteInterview,
  getListInterviewsQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { formatRelative, formatDate } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { MessagesSquare, Plus, Trash2, Edit } from "lucide-react";

export default function InterviewsView() {
  const params = useParams();
  const id = params.id as string;
  const [_, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: interviews, isLoading } = useListInterviews(id, {
    query: { enabled: !!id }
  });

  const deleteInterview = useDeleteInterview();

  const handleDelete = (interviewId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm("Delete this interview?")) {
      deleteInterview.mutate({ id: interviewId }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListInterviewsQueryKey(id) });
          toast({ title: "Interview deleted" });
        }
      });
    }
  };

  return (
    <AppLayout engagementId={id}>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Interviews</h1>
          <p className="text-muted-foreground mt-1">Qualitative insights and context collection.</p>
        </div>
        <CreateInterviewDialog engagementId={id} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Conducted Interviews</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : !interviews || interviews.length === 0 ? (
            <div className="text-center py-12 border rounded bg-muted/20 border-dashed">
              <MessagesSquare className="h-8 w-8 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">No Interviews Logged</h3>
              <p className="text-muted-foreground mb-4 max-w-sm mx-auto">
                Add an interview to start recording notes and extracting evidence.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Interviewee</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Evidence</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {interviews.map(inv => (
                  <TableRow 
                    key={inv.id} 
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => setLocation(`/engagements/${id}/interviews/${inv.id}`)}
                  >
                    <TableCell className="font-medium">{inv.interviewee}</TableCell>
                    <TableCell>{inv.role}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{inv.date ? formatDate(inv.date) : '-'}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">{inv.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono">{inv.evidenceCount || 0}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive hover:bg-destructive/10" onClick={(e) => handleDelete(inv.id, e)}>
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
    </AppLayout>
  );
}

function CreateInterviewDialog({ engagementId }: { engagementId: string }) {
  const [open, setOpen] = useState(false);
  const [interviewee, setInterviewee] = useState("");
  const [role, setRole] = useState("");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const createInterview = useCreateInterview();

  const handleCreate = () => {
    if (!interviewee || !role) return;

    createInterview.mutate(
      { id: engagementId, data: { interviewee, role } },
      {
        onSuccess: (data) => {
          queryClient.invalidateQueries({ queryKey: getListInterviewsQueryKey(engagementId) });
          toast({ title: "Interview created" });
          setOpen(false);
          setInterviewee("");
          setRole("");
          setLocation(`/engagements/${engagementId}/interviews/${data.id}`);
        }
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2">
          <Plus className="h-4 w-4" /> Add Interview
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Interview</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Interviewee Name</label>
            <Input value={interviewee} onChange={e => setInterviewee(e.target.value)} placeholder="John Doe" />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Role</label>
            <Input value={role} onChange={e => setRole(e.target.value)} placeholder="VP of Engineering" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleCreate} disabled={createInterview.isPending || !interviewee || !role}>
            {createInterview.isPending ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
