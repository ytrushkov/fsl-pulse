import { useState } from "react";
import {
  useListEngagements,
  useGetMe,
  useListOrphanEngagements,
  useClaimOrphanEngagement,
  useDeleteOrphanEngagement,
  getListEngagementsQueryKey,
  getListOrphanEngagementsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { formatRelative, formatDate } from "@/lib/format";
import { AppLayout } from "@/components/layout/app-layout";
import { CreateEngagementDialog } from "@/components/engagements/create-engagement-dialog";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  CalendarDays,
  Users,
  ShieldAlert,
  HandHeart,
  Trash2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function EngagementsList() {
  const { data: engagements, isLoading } = useListEngagements();
  const { data: me } = useGetMe();
  const isAdmin = me?.role === "admin";

  return (
    <AppLayout>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Engagements</h1>
          <p className="text-muted-foreground mt-1">
            Manage your active and past client diagnostics.
          </p>
        </div>
        <CreateEngagementDialog />
      </div>

      {isLoading ? (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {[...Array(6)].map((_, i) => (
            <Card key={i} className="overflow-hidden">
              <CardHeader className="pb-4 border-b">
                <Skeleton className="h-6 w-2/3" />
                <Skeleton className="h-4 w-1/3 mt-2" />
              </CardHeader>
              <CardContent className="py-4">
                <Skeleton className="h-4 w-full mb-2" />
                <Skeleton className="h-4 w-4/5" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : engagements?.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center border rounded-lg bg-muted/20 border-dashed">
          <div className="rounded-full bg-muted p-4 mb-4">
            <CalendarDays className="h-8 w-8 text-muted-foreground" />
          </div>
          <h2 className="text-xl font-semibold mb-2">No Engagements Found</h2>
          <p className="text-muted-foreground max-w-md mb-6">
            You don't have any active engagements yet. Create a new engagement
            to start assessing.
            {isAdmin ? (
              <>
                {" "}
                If you're expecting demo data here, an admin can review the
                orphaned engagements panel below — these are engagements that
                exist in the database but have no member assigned (typically
                seed data created before sign-in).
              </>
            ) : (
              <>
                {" "}
                If you're expecting to see seed data, ask an admin to claim
                any orphaned engagements for you.
              </>
            )}
          </p>
          <CreateEngagementDialog />
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {engagements?.map((engagement) => (
            <Link key={engagement.id} href={`/engagements/${engagement.id}`}>
              <Card className="h-full overflow-hidden hover-elevate transition-all cursor-pointer group hover:border-primary/50">
                <CardHeader className="pb-4 border-b bg-muted/10 group-hover:bg-muted/30 transition-colors">
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="text-xl font-bold group-hover:text-primary transition-colors">
                        {engagement.clientName}
                      </CardTitle>
                      <p className="text-sm text-muted-foreground mt-1 flex items-center gap-1.5">
                        <Users className="h-3.5 w-3.5" />
                        {engagement.sponsor}
                      </p>
                    </div>
                    <Badge
                      variant={
                        engagement.status === "active"
                          ? "default"
                          : engagement.status === "collecting"
                            ? "secondary"
                            : engagement.status === "archived"
                              ? "outline"
                              : "outline"
                      }
                      className="capitalize"
                    >
                      {engagement.status.replace("_", " ")}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="py-4">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="text-muted-foreground mb-1 text-xs uppercase tracking-wider font-semibold">
                        Teams
                      </p>
                      <p className="font-medium font-mono">
                        {engagement.teamCount}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground mb-1 text-xs uppercase tracking-wider font-semibold">
                        Target Date
                      </p>
                      <p className="font-medium">
                        {engagement.targetDeliveryDate
                          ? formatDate(engagement.targetDeliveryDate)
                          : "Not set"}
                      </p>
                    </div>
                  </div>
                </CardContent>
                <CardFooter className="py-3 px-6 border-t bg-muted/5 text-xs text-muted-foreground flex justify-between">
                  <span>Created {formatRelative(engagement.createdAt)}</span>
                  <span className="group-hover:text-primary transition-colors font-medium">
                    View details &rarr;
                  </span>
                </CardFooter>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {isAdmin && <OrphanEngagementsPanel />}
    </AppLayout>
  );
}

/**
 * Admin-only panel that surfaces engagements without any member rows so the
 * signed-in admin can either claim ownership or delete them. These engagements
 * are otherwise invisible because the engagements list filters by membership.
 */
function OrphanEngagementsPanel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: orphans, isLoading } = useListOrphanEngagements();
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: getListOrphanEngagementsQueryKey() });
    qc.invalidateQueries({ queryKey: getListEngagementsQueryKey() });
  };

  const claim = useClaimOrphanEngagement({
    mutation: {
      onSuccess: (eng) => {
        refresh();
        toast({
          title: "Engagement claimed",
          description: `You're now the owner of ${eng.clientName}.`,
        });
      },
      onError: (err: unknown) => {
        const msg =
          err instanceof Error ? err.message : "Could not claim engagement";
        toast({
          title: "Claim failed",
          description: msg,
          variant: "destructive",
        });
      },
    },
  });

  const remove = useDeleteOrphanEngagement({
    mutation: {
      onSuccess: () => {
        refresh();
        setPendingDeleteId(null);
        toast({
          title: "Engagement deleted",
          description: "The orphaned engagement has been removed.",
        });
      },
      onError: (err: unknown) => {
        const msg =
          err instanceof Error ? err.message : "Could not delete engagement";
        toast({
          title: "Delete failed",
          description: msg,
          variant: "destructive",
        });
      },
    },
  });

  if (!isLoading && (!orphans || orphans.length === 0)) {
    return null;
  }

  const pendingDelete = orphans?.find((o) => o.id === pendingDeleteId) ?? null;

  return (
    <section className="mt-12">
      <div className="flex items-center gap-2 mb-3">
        <ShieldAlert className="h-5 w-5 text-amber-500" />
        <h2 className="text-xl font-semibold tracking-tight">
          Orphaned engagements
        </h2>
        <Badge variant="outline" className="ml-1">
          admin
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground mb-4 max-w-3xl">
        These engagements exist in the database but have no member assigned, so
        they don't appear in anyone's engagements list. Claim one to become its
        owner, or delete it if it's stale demo data.
      </p>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {orphans?.map((eng) => (
            <Card key={eng.id} className="border-amber-500/30">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-base">{eng.clientName}</CardTitle>
                    <p className="text-xs text-muted-foreground mt-1">
                      {eng.sponsor} · {eng.teamCount} teams · created{" "}
                      {formatRelative(eng.createdAt)}
                    </p>
                  </div>
                  <Badge variant="outline" className="capitalize">
                    {eng.status.replace("_", " ")}
                  </Badge>
                </div>
              </CardHeader>
              <CardFooter className="pt-0 gap-2">
                <Button
                  size="sm"
                  onClick={() => claim.mutate({ id: eng.id })}
                  disabled={claim.isPending || remove.isPending}
                  data-testid={`button-claim-orphan-${eng.id}`}
                >
                  <HandHeart className="h-4 w-4 mr-1.5" />
                  Claim as owner
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setPendingDeleteId(eng.id)}
                  disabled={claim.isPending || remove.isPending}
                  data-testid={`button-delete-orphan-${eng.id}`}
                >
                  <Trash2 className="h-4 w-4 mr-1.5" />
                  Delete
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      <AlertDialog
        open={pendingDeleteId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete orphaned engagement?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete{" "}
              <strong>{pendingDelete?.clientName}</strong> and all of its
              surveys, interviews, deliverables, and activity history. This
              action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (pendingDeleteId) remove.mutate({ id: pendingDeleteId });
              }}
              disabled={remove.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {remove.isPending ? "Deleting…" : "Delete engagement"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
