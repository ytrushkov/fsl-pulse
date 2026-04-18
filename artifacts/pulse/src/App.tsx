import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import EngagementsList from "@/pages/engagements/index";
import EngagementOverview from "@/pages/engagements/overview";
import ConnectorsList from "@/pages/engagements/connectors";
import ArtifactsView from "@/pages/engagements/artifacts";
import ScoringView from "@/pages/engagements/scoring";
import SurveyView from "@/pages/engagements/survey";
import InterviewsView from "@/pages/engagements/interviews";
import InterviewDetailView from "@/pages/engagements/interview-detail";
import ResultsView from "@/pages/engagements/results";
import ExportsView from "@/pages/engagements/exports";
import PublicSurveyForm from "@/pages/survey/public-survey";

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/" component={EngagementsList} />
      <Route path="/engagements" component={EngagementsList} />
      <Route path="/engagements/:id" component={EngagementOverview} />
      <Route path="/engagements/:id/connectors" component={ConnectorsList} />
      <Route path="/engagements/:id/artifacts" component={ArtifactsView} />
      <Route path="/engagements/:id/scoring" component={ScoringView} />
      <Route path="/engagements/:id/survey" component={SurveyView} />
      <Route path="/engagements/:id/interviews" component={InterviewsView} />
      <Route path="/engagements/:id/interviews/:interviewId" component={InterviewDetailView} />
      <Route path="/engagements/:id/results/*" component={ResultsView} />
      <Route path="/engagements/:id/results" component={ResultsView} />
      <Route path="/engagements/:id/exports" component={ExportsView} />
      <Route path="/survey/respond/:token" component={PublicSurveyForm} />
      
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
