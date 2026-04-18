import { useState } from "react";
import { useParams, useLocation } from "wouter";
import { AppLayout } from "@/components/layout/app-layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useGetDeliverables } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";

// Import sub-views
import HeatmapView from "./results/heatmap";
import GapAnalysisView from "./results/gap-analysis";
import ActionPlanView from "./results/action-plan";
import EntryPointView from "./results/entry-point";
import NpvView from "./results/npv";

export default function ResultsView() {
  const params = useParams();
  const id = params.id as string;
  const [location, setLocation] = useLocation();

  // Extract the tab from the URL path: /engagements/:id/results/:tab
  const match = location.match(/\/results\/(heatmap|gap-analysis|action-plan|entry-point|npv)$/);
  const activeTab = match ? match[1] : "heatmap";

  const { data: deliverables, isLoading } = useGetDeliverables(id, {
    query: { enabled: !!id }
  });

  const handleTabChange = (val: string) => {
    setLocation(`/engagements/${id}/results/${val}`);
  };

  if (isLoading) {
    return (
      <AppLayout engagementId={id}>
        <Skeleton className="h-10 w-48 mb-6" />
        <Skeleton className="h-full min-h-[500px] w-full" />
      </AppLayout>
    );
  }

  return (
    <AppLayout engagementId={id}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-serif font-bold tracking-tight">Board Readout Deliverables</h1>
          <p className="text-muted-foreground mt-1">Final synthesized recommendations and data.</p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
        <TabsList className="mb-6 w-full justify-start h-12 bg-muted/50 p-1 border">
          <TabsTrigger value="heatmap" className="px-6 data-[state=active]:bg-background">Heatmap</TabsTrigger>
          <TabsTrigger value="gap-analysis" className="px-6 data-[state=active]:bg-background">Gap Analysis</TabsTrigger>
          <TabsTrigger value="action-plan" className="px-6 data-[state=active]:bg-background">Action Plan</TabsTrigger>
          <TabsTrigger value="entry-point" className="px-6 data-[state=active]:bg-background">Entry Point</TabsTrigger>
          <TabsTrigger value="npv" className="px-6 data-[state=active]:bg-background">Business Case</TabsTrigger>
        </TabsList>

        <div className="bg-card border rounded-lg shadow-sm min-h-[60vh] p-1">
          <TabsContent value="heatmap" className="m-0 p-0 border-0">
            <HeatmapView engagementId={id} deliverables={deliverables} />
          </TabsContent>
          <TabsContent value="gap-analysis" className="m-0 p-0 border-0">
            <GapAnalysisView engagementId={id} deliverables={deliverables} />
          </TabsContent>
          <TabsContent value="action-plan" className="m-0 p-0 border-0">
            <ActionPlanView engagementId={id} deliverables={deliverables} />
          </TabsContent>
          <TabsContent value="entry-point" className="m-0 p-0 border-0">
            <EntryPointView engagementId={id} deliverables={deliverables} />
          </TabsContent>
          <TabsContent value="npv" className="m-0 p-0 border-0">
            <NpvView engagementId={id} deliverables={deliverables} />
          </TabsContent>
        </div>
      </Tabs>
    </AppLayout>
  );
}
