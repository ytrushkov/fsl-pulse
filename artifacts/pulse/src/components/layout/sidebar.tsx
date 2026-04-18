import { Link, useLocation } from "wouter";
import { useListEngagements } from "@workspace/api-client-react";
import { Activity, Briefcase, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";

export function Sidebar() {
  const [location] = useLocation();
  const { data: engagements, isLoading } = useListEngagements();

  return (
    <div className="flex h-full w-64 flex-col border-r bg-sidebar">
      <div className="flex h-14 items-center border-b px-4">
        <Link href="/" className="flex items-center gap-2 font-serif text-lg font-bold text-sidebar-primary">
          <Activity className="h-5 w-5" />
          <span>Pulse</span>
        </Link>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="mb-4">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Find engagement..."
              className="w-full bg-sidebar-accent/50 pl-8 text-sm"
            />
          </div>
        </div>

        <div className="space-y-1">
          <h2 className="mb-2 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Engagements
          </h2>
          
          {isLoading ? (
            <div className="space-y-2 px-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : engagements?.length === 0 ? (
            <div className="px-2 text-sm text-muted-foreground">No engagements yet.</div>
          ) : (
            engagements?.map((engagement) => {
              const isActive = location.startsWith(`/engagements/${engagement.id}`);
              return (
                <Link
                  key={engagement.id}
                  href={`/engagements/${engagement.id}`}
                  className={`group flex items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors ${
                    isActive
                      ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium"
                      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  }`}
                >
                  <span className="truncate">{engagement.clientName}</span>
                  {engagement.status === 'active' && (
                    <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                  )}
                  {engagement.status === 'collecting' && (
                    <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                  )}
                </Link>
              );
            })
          )}
        </div>
      </div>

      <div className="border-t p-4">
        <Link href="/engagements" className="w-full">
          <Button variant="outline" className="w-full justify-start gap-2">
            <Briefcase className="h-4 w-4" />
            All Engagements
          </Button>
        </Link>
      </div>
    </div>
  );
}
