import { Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface LockBadgeProps {
  meta?: {
    lockedByName?: string | null;
    lockedByEmail?: string | null;
    lockedAt: string;
    version?: number;
  } | null;
}

export function LockBadge({ meta }: LockBadgeProps) {
  if (!meta) return null;
  const who = meta.lockedByName || meta.lockedByEmail || "an editor";
  const when = new Date(meta.lockedAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return (
    <Badge
      variant="outline"
      className="gap-1 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
      title={meta.lockedByEmail ?? undefined}
    >
      <Lock className="h-3 w-3" />
      Locked by {who} · {when}
      {typeof meta.version === "number" && (
        <span className="opacity-70 ml-1">v{meta.version}</span>
      )}
    </Badge>
  );
}
