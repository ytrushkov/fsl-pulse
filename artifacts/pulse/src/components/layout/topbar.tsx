import { Link, useLocation } from "wouter";
import { useGetEngagement } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

interface TopbarProps {
  engagementId?: string;
}

export function Topbar({ engagementId }: TopbarProps) {
  const [location] = useLocation();
  const { data: engagement, isLoading } = useGetEngagement(engagementId || "", {
    query: { enabled: !!engagementId }
  });

  const tabs = engagementId ? [
    { label: "Overview", path: `/engagements/${engagementId}` },
    { label: "Connectors", path: `/engagements/${engagementId}/connectors` },
    { label: "Survey", path: `/engagements/${engagementId}/survey` },
    { label: "Interviews", path: `/engagements/${engagementId}/interviews` },
    { label: "Artifacts", path: `/engagements/${engagementId}/artifacts` },
    { label: "Scoring", path: `/engagements/${engagementId}/scoring` },
    { label: "Results", path: `/engagements/${engagementId}/results` },
    { label: "Exports", path: `/engagements/${engagementId}/exports` },
  ] : [];

  return (
    <header className="sticky top-0 z-30 flex flex-col border-b bg-background">
      <div className="flex h-14 items-center justify-between px-6">
        <div className="flex items-center gap-4">
          {isLoading ? (
            <Skeleton className="h-6 w-48" />
          ) : engagement ? (
            <>
              <h1 className="text-xl font-bold font-serif">{engagement.clientName}</h1>
              <Badge variant="outline" className="capitalize">{engagement.status}</Badge>
            </>
          ) : (
            <h1 className="text-xl font-bold font-serif">Engagements</h1>
          )}
        </div>
        
        <div className="flex items-center gap-4">
          {/* User profile / settings could go here */}
        </div>
      </div>

      {tabs.length > 0 && (
        <div className="flex px-6 space-x-1 border-t bg-muted/20">
          {tabs.map((tab) => {
            const isActive = location === tab.path || (tab.path.endsWith('/results') && location.startsWith(tab.path));
            return (
              <Link
                key={tab.path}
                href={tab.path}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors hover:text-primary ${
                  isActive
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
      )}
    </header>
  );
}
