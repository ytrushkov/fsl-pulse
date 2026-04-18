import { useState } from "react";
import { useParams } from "wouter";
import { 
  useGetSurvey, 
  useUpdateSurvey, 
  useGetSurveyAggregates,
  useListSurveyInvites,
  useCreateSurveyInvites,
  getGetSurveyQueryKey,
  getGetSurveyAggregatesQueryKey,
  getListSurveyInvitesQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { formatRelative } from "@/lib/format";
import { Send, Users, LayoutList, Download, Mail } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

export default function SurveyView() {
  const params = useParams();
  const id = params.id as string;
  const [activeTab, setActiveTab] = useState("builder");

  return (
    <AppLayout engagementId={id}>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Survey</h1>
          <p className="text-muted-foreground mt-1">Configure assessment questionnaire and analyze responses.</p>
        </div>
        <DistributeDialog engagementId={id} />
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-6">
          <TabsTrigger value="builder" className="gap-2">
            <LayoutList className="h-4 w-4" /> Builder
          </TabsTrigger>
          <TabsTrigger value="responses" className="gap-2">
            <Users className="h-4 w-4" /> Responses
          </TabsTrigger>
        </TabsList>

        <TabsContent value="builder">
          <SurveyBuilder engagementId={id} />
        </TabsContent>
        
        <TabsContent value="responses">
          <SurveyResponses engagementId={id} />
        </TabsContent>
      </Tabs>
    </AppLayout>
  );
}

function SurveyBuilder({ engagementId }: { engagementId: string }) {
  const { data: survey, isLoading } = useGetSurvey(engagementId, {
    query: { enabled: !!engagementId }
  });

  if (isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }

  if (!survey) {
    return <div>No survey configuration found.</div>;
  }

  const groupedQuestions = survey.questions.reduce((acc, q) => {
    if (!acc[q.section]) acc[q.section] = [];
    acc[q.section].push(q);
    return acc;
  }, {} as Record<string, typeof survey.questions>);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Modules</CardTitle>
          <CardDescription>Active assessment areas</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {survey.modules.map(m => (
              <Badge key={m} variant="secondary" className="capitalize">{m}</Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      {Object.entries(groupedQuestions).map(([section, questions]) => (
        <Card key={section}>
          <CardHeader className="bg-muted/30 pb-3">
            <CardTitle className="text-lg capitalize">{section.replace('_', ' ')}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Prompt</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Dimension</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {questions.map(q => (
                  <TableRow key={q.id}>
                    <TableCell className="font-medium max-w-md">{q.prompt}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">{q.type.replace('_', ' ')}</Badge>
                    </TableCell>
                    <TableCell>
                      {q.dimension ? <Badge className="capitalize">{q.dimension}</Badge> : '-'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function SurveyResponses({ engagementId }: { engagementId: string }) {
  const { data: aggregates, isLoading } = useGetSurveyAggregates(engagementId, {
    query: { enabled: !!engagementId }
  });

  if (isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }

  if (!aggregates || aggregates.totalCompleted === 0) {
    return (
      <div className="text-center py-16 border rounded bg-muted/10 border-dashed">
        <Users className="h-10 w-10 mx-auto text-muted-foreground mb-4" />
        <h3 className="text-xl font-medium mb-2">No Responses Yet</h3>
        <p className="text-muted-foreground mb-4 max-w-sm mx-auto">
          Distribute the survey to client teams to begin collecting data.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Response Rate</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{Math.round(aggregates.responseRate * 100)}%</div>
            <p className="text-xs text-muted-foreground mt-1">
              {aggregates.totalCompleted} of {aggregates.totalSent} completed
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Team Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Team</TableHead>
                <TableHead>Completed</TableHead>
                <TableHead>Tooling</TableHead>
                <TableHead>Process</TableHead>
                <TableHead>Culture</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {aggregates.byTeam.map((t, i) => (
                <TableRow key={i}>
                  <TableCell className="font-medium">{t.team}</TableCell>
                  <TableCell>{t.completedCount}</TableCell>
                  {t.suppressed ? (
                    <TableCell colSpan={3} className="text-muted-foreground italic text-sm">
                      Hidden — fewer than 5 respondents (anonymity threshold)
                    </TableCell>
                  ) : (
                    <>
                      <TableCell className="font-mono">{t.dimensionAverages?.tooling?.toFixed(1) || '-'}</TableCell>
                      <TableCell className="font-mono">{t.dimensionAverages?.process?.toFixed(1) || '-'}</TableCell>
                      <TableCell className="font-mono">{t.dimensionAverages?.culture?.toFixed(1) || '-'}</TableCell>
                    </>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function DistributeDialog({ engagementId }: { engagementId: string }) {
  const [open, setOpen] = useState(false);
  const [csvData, setCsvData] = useState("");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createInvites = useCreateSurveyInvites();

  const handleSend = () => {
    if (!csvData.trim()) return;

    const lines = csvData.split('\n').map(l => l.trim()).filter(Boolean);
    const invites = lines.map(line => {
      const [team, email] = line.split(',').map(s => s.trim());
      return { team, email: email || undefined };
    });

    createInvites.mutate(
      { id: engagementId, data: { invites } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSurveyInvitesQueryKey(engagementId) });
          queryClient.invalidateQueries({ queryKey: getGetSurveyAggregatesQueryKey(engagementId) });
          toast({ title: "Invites Sent", description: `Sent ${invites.length} survey invitations.` });
          setCsvData("");
          setOpen(false);
        },
        onError: () => {
          toast({ variant: "destructive", title: "Error", description: "Failed to send invites." });
        }
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2">
          <Send className="h-4 w-4" /> Distribute Survey
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Distribute Survey</DialogTitle>
          <DialogDescription>
            Paste CSV data containing team and email to send unique survey links.
            Format: Team,Email
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <Textarea 
            placeholder="Engineering, alice@example.com&#10;Product, bob@example.com" 
            className="min-h-[150px] font-mono text-sm"
            value={csvData}
            onChange={e => setCsvData(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSend} disabled={createInvites.isPending || !csvData.trim()}>
            {createInvites.isPending ? "Sending..." : "Send Invites"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
