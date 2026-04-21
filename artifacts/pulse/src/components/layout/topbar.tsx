import { Link, useLocation } from "wouter";
import { UserButton } from "@clerk/react";
import {
  useGetEngagement,
  getGetEngagementQueryKey,
} from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/theme-toggle";

interface TopbarProps {
  engagementId?: string;
}

export function Topbar({ engagementId }: TopbarProps) {
  const [location] = useLocation();
  const { data: engagement, isLoading } = useGetEngagement(engagementId || "", {
    query: {
      enabled: !!engagementId,
      queryKey: getGetEngagementQueryKey(engagementId || ""),
    },
  });

  const tabs = engagementId
    ? [
        { label: "Overview", path: `/engagements/${engagementId}` },
        { label: "Connectors", path: `/engagements/${engagementId}/connectors` },
        { label: "Survey", path: `/engagements/${engagementId}/survey` },
        { label: "Interviews", path: `/engagements/${engagementId}/interviews` },
        { label: "Artifacts", path: `/engagements/${engagementId}/artifacts` },
        { label: "Scoring", path: `/engagements/${engagementId}/scoring` },
        { label: "Results", path: `/engagements/${engagementId}/results` },
        { label: "Exports", path: `/engagements/${engagementId}/exports` },
      ]
    : [];

  return (
    <header className="sticky top-0 z-30 flex flex-col border-b border-border bg-background">
      <div className="flex h-16 items-center justify-between px-6">
        <div className="flex items-center gap-3">
          {isLoading ? (
            <Skeleton className="h-7 w-48" />
          ) : engagement ? (
            <>
              <h1 className="text-2xl font-extrabold tracking-tight text-foreground">
                {engagement.clientName}
              </h1>
              <Badge
                variant="outline"
                className="border-primary/40 bg-primary/10 capitalize text-primary"
              >
                {engagement.status}
              </Badge>
            </>
          ) : (
            <h1 className="text-2xl font-extrabold tracking-tight text-foreground">
              Engagements
            </h1>
          )}
        </div>

        <div className="flex items-center gap-4">
          <a
            href="https://www.fullstack.com/ai-maturity-assessments"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-cta-neon"
          >
            Get Started
          </a>
          <ThemeToggle />
          <UserButton
            appearance={{
              elements: {
                userButtonAvatarBox: "h-9 w-9 ring-2 ring-accent/40",
              },
            }}
          />
        </div>
      </div>

      {tabs.length > 0 && (
        <div className="flex space-x-1 border-t border-border bg-card/40 px-6">
          {tabs.map((tab) => {
            const isActive =
              location === tab.path ||
              (tab.path.endsWith("/results") && location.startsWith(tab.path));
            return (
              <Link
                key={tab.path}
                href={tab.path}
                className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors ${
                  isActive
                    ? "border-accent text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
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
