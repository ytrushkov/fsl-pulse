import { useGetEngagement, useGetEngagementDashboard } from "@workspace/api-client-react";
import { useParams } from "wouter";
import { AppLayout } from "@/components/layout/app-layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { 
  Database, 
  FileText, 
  MessagesSquare, 
  Files, 
  Target, 
  Presentation,
  ArrowRight,
  Activity,
  Play
} from "lucide-react";
import { Link } from "wouter";
import { Progress } from "@/components/ui/progress";

export default function EngagementOverview() {
  const params = useParams();
  const id = params.id as string;
  
  const { data: engagement, isLoading: isLoadingEngagement } = useGetEngagement(id, {
    query: { enabled: !!id }
  });
  
  const { data: dashboard, isLoading: isLoadingDashboard } = useGetEngagementDashboard(id, {
    query: { enabled: !!id }
  });

  const isLoading = isLoadingEngagement || isLoadingDashboard;

  return (
    <AppLayout engagementId={id}>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-serif font-bold tracking-tight">Workspace Overview</h1>
          <p className="text-muted-foreground mt-1">
            {isLoading ? <Skeleton className="h-4 w-48" /> : `Status and progress for ${engagement?.clientName}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" className="gap-2">
            <Play className="h-4 w-4" />
            Run all connectors
          </Button>
          <Link href={`/engagements/${id}/exports`}>
            <Button className="gap-2">
              <FileText className="h-4 w-4" />
              Export Bundle
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 mb-8">
        {/* Connectors Tile */}
        <Card className="hover:border-primary/50 transition-colors">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg font-serif flex items-center gap-2">
                <Database className="h-5 w-5 text-chart-1" />
                Connectors
              </CardTitle>
              <Link href={`/engagements/${id}/connectors`}>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary">
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
            <CardDescription>System integrations & automated data</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingDashboard ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <div className="flex items-end gap-2">
                <span className="text-3xl font-bold font-mono">{dashboard?.connectorsHealthy || 0}</span>
                <span className="text-muted-foreground mb-1">/ {dashboard?.connectorsTotal || 0} healthy</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Survey Tile */}
        <Card className="hover:border-primary/50 transition-colors">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg font-serif flex items-center gap-2">
                <FileText className="h-5 w-5 text-chart-2" />
                Survey
              </CardTitle>
              <Link href={`/engagements/${id}/survey`}>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary">
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
            <CardDescription>Team perception & self-reporting</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingDashboard ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <div>
                <div className="flex items-end justify-between mb-2">
                  <div className="flex items-end gap-2">
                    <span className="text-3xl font-bold font-mono">{dashboard?.surveyCompleted || 0}</span>
                    <span className="text-muted-foreground mb-1">/ {dashboard?.surveySent || 0} responses</span>
                  </div>
                  <span className="text-sm font-medium">{Math.round((dashboard?.surveyResponseRate || 0) * 100)}%</span>
                </div>
                <Progress value={(dashboard?.surveyResponseRate || 0) * 100} className="h-2" />
              </div>
            )}
          </CardContent>
        </Card>

        {/* Interviews Tile */}
        <Card className="hover:border-primary/50 transition-colors">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg font-serif flex items-center gap-2">
                <MessagesSquare className="h-5 w-5 text-chart-3" />
                Interviews
              </CardTitle>
              <Link href={`/engagements/${id}/interviews`}>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary">
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
            <CardDescription>Qualitative insights & context</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingDashboard ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <div className="flex items-end gap-2">
                <span className="text-3xl font-bold font-mono">{dashboard?.interviewsCompleted || 0}</span>
                <span className="text-muted-foreground mb-1">/ {dashboard?.interviewsTotal || 0} completed</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Artifacts Tile */}
        <Card className="hover:border-primary/50 transition-colors">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg font-serif flex items-center gap-2">
                <Files className="h-5 w-5 text-chart-4" />
                Artifacts
              </CardTitle>
              <Link href={`/engagements/${id}/artifacts`}>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary">
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
            <CardDescription>Documents & diagrams</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingDashboard ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <div className="flex items-end gap-2">
                <span className="text-3xl font-bold font-mono">{dashboard?.artifactCount || 0}</span>
                <span className="text-muted-foreground mb-1">documents collected</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Scoring Tile */}
        <Card className="hover:border-primary/50 transition-colors bg-secondary/30">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg font-serif flex items-center gap-2">
                <Target className="h-5 w-5 text-primary" />
                Scoring
              </CardTitle>
              <Link href={`/engagements/${id}/scoring`}>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary">
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
            <CardDescription>Dimension evaluation & overrides</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingDashboard ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <div className="flex flex-col gap-1 text-sm">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Activity className="h-4 w-4" />
                  <span>Based on {dashboard?.evidenceCount || 0} pieces of evidence</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Deliverables Tile */}
        <Card className="hover:border-primary/50 transition-colors bg-primary/5 border-primary/20">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg font-serif flex items-center gap-2 text-primary">
                <Presentation className="h-5 w-5" />
                Deliverables
              </CardTitle>
              <Link href={`/engagements/${id}/results/heatmap`}>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-primary hover:text-primary/80">
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
            <CardDescription className="text-primary/70">Final outputs & recommendations</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingDashboard ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <div className="grid grid-cols-2 gap-2 text-xs">
                {Object.entries(dashboard?.deliverableStatuses || {}).map(([key, status]) => (
                  <div key={key} className="flex items-center justify-between p-1.5 bg-background rounded border">
                    <span className="capitalize">{key.replace(/([A-Z])/g, ' $1').trim()}</span>
                    <div className={`h-2 w-2 rounded-full ${
                      status === 'locked' ? 'bg-green-500' :
                      status === 'reviewed' ? 'bg-blue-500' : 'bg-muted-foreground/30'
                    }`} />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      
    </AppLayout>
  );
}
