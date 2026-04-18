import { ReactNode } from "react";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { Sparkles } from "lucide-react";

interface AppLayoutProps {
  children: ReactNode;
  engagementId?: string;
}

export function AppLayout({ children, engagementId }: AppLayoutProps) {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {/* FullStack-style top promo banner */}
      <div className="flex h-9 shrink-0 items-center justify-center gap-2 bg-primary text-xs font-medium text-primary-foreground">
        <Sparkles className="h-3.5 w-3.5" />
        <span>Accelerate your AI transformation with FullStack.</span>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <Topbar engagementId={engagementId} />
          <main className="flex-1 overflow-y-auto bg-background p-6">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
