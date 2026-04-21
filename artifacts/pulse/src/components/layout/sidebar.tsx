import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useListEngagements } from "@workspace/api-client-react";
import {
  Briefcase,
  Search,
  BookCheck,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const STORAGE_KEY = "pulse.sidebar.collapsed";

function PulseMark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      <path
        d="M4 16h6l3-9 6 18 3-9h6"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Sidebar() {
  const [location] = useLocation();
  const { data: engagements, isLoading } = useListEngagements();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  const toggle = () => setCollapsed((c) => !c);

  return (
    <TooltipProvider delayDuration={100}>
      <div
        className={`flex h-full flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200 ease-out ${
          collapsed ? "w-14" : "w-64"
        }`}
        data-testid="sidebar"
        data-collapsed={collapsed}
      >
        <div
          className={`flex h-16 items-center border-b border-sidebar-border ${
            collapsed ? "justify-center px-2" : "justify-between px-5"
          }`}
        >
          {collapsed ? (
            <Link
              href="/"
              className="flex items-center text-sidebar-foreground"
              aria-label="Pulse home"
            >
              <span className="text-primary">
                <PulseMark />
              </span>
            </Link>
          ) : (
            <>
              <Link
                href="/"
                className="flex items-center gap-2.5 text-xl font-extrabold tracking-tight text-sidebar-foreground"
              >
                <span className="text-primary">
                  <PulseMark />
                </span>
                <span>Pulse</span>
              </Link>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-sidebar-foreground/70 hover:text-sidebar-foreground"
                    onClick={toggle}
                    aria-label="Collapse sidebar"
                    data-testid="button-toggle-sidebar"
                  >
                    <PanelLeftClose className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">Collapse sidebar</TooltipContent>
              </Tooltip>
            </>
          )}
        </div>

        {collapsed ? (
          <div className="flex flex-1 flex-col items-center gap-1 overflow-y-auto p-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 text-sidebar-foreground/70 hover:text-sidebar-foreground"
                  onClick={toggle}
                  aria-label="Expand sidebar"
                  data-testid="button-toggle-sidebar"
                >
                  <PanelLeftOpen className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Expand sidebar</TooltipContent>
            </Tooltip>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-4">
            <div className="mb-4">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  type="search"
                  placeholder="Find engagement..."
                  className="w-full border-sidebar-border bg-sidebar-accent/40 pl-8 text-sm placeholder:text-muted-foreground"
                />
              </div>
            </div>

            <div className="space-y-1">
              <h2 className="mb-3 px-2 text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
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
                      className={`group flex items-center justify-between rounded-md px-2.5 py-2 text-sm transition-colors ${
                        isActive
                          ? "bg-primary/15 font-semibold text-sidebar-foreground ring-1 ring-inset ring-primary/40"
                          : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                      }`}
                    >
                      <span className="truncate">{engagement.clientName}</span>
                      {engagement.status === "active" && (
                        <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_6px_hsl(var(--accent))]" />
                      )}
                      {engagement.status === "collecting" && (
                        <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                      )}
                    </Link>
                  );
                })
              )}
            </div>
          </div>
        )}

        <div
          className={`border-t border-sidebar-border ${
            collapsed ? "flex flex-col items-center gap-2 p-2" : "p-4 space-y-2"
          }`}
        >
          {collapsed ? (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link href="/portfolio" aria-label="Portfolio">
                    <Button
                      variant={location.startsWith("/portfolio") ? "default" : "outline"}
                      size="icon"
                      className="h-9 w-9 border-sidebar-border bg-transparent text-sidebar-foreground hover:bg-sidebar-accent"
                      data-testid="link-portfolio"
                    >
                      <LayoutDashboard className="h-4 w-4" />
                    </Button>
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="right">Portfolio</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link href="/engagements" aria-label="All Engagements">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-9 w-9 border-sidebar-border bg-transparent text-sidebar-foreground hover:bg-sidebar-accent"
                    >
                      <Briefcase className="h-4 w-4" />
                    </Button>
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="right">All Engagements</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link href="/rubrics" aria-label="Scoring Rubrics">
                    <Button
                      variant={location.startsWith("/rubrics") ? "default" : "outline"}
                      size="icon"
                      className="h-9 w-9 border-sidebar-border bg-transparent text-sidebar-foreground hover:bg-sidebar-accent"
                    >
                      <BookCheck className="h-4 w-4" />
                    </Button>
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="right">Scoring Rubrics</TooltipContent>
              </Tooltip>
            </>
          ) : (
            <>
              <Link href="/portfolio" className="w-full">
                <Button
                  variant={location.startsWith("/portfolio") ? "default" : "outline"}
                  className="w-full justify-start gap-2 border-sidebar-border bg-transparent text-sidebar-foreground hover:bg-sidebar-accent"
                  data-testid="link-portfolio"
                >
                  <LayoutDashboard className="h-4 w-4" />
                  Portfolio
                </Button>
              </Link>
              <Link href="/engagements" className="w-full">
                <Button
                  variant="outline"
                  className="w-full justify-start gap-2 border-sidebar-border bg-transparent text-sidebar-foreground hover:bg-sidebar-accent"
                >
                  <Briefcase className="h-4 w-4" />
                  All Engagements
                </Button>
              </Link>
              <Link href="/rubrics" className="w-full">
                <Button
                  variant={location.startsWith("/rubrics") ? "default" : "outline"}
                  className="w-full justify-start gap-2 border-sidebar-border bg-transparent text-sidebar-foreground hover:bg-sidebar-accent"
                >
                  <BookCheck className="h-4 w-4" />
                  Scoring Rubrics
                </Button>
              </Link>
            </>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
