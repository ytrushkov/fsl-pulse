import { useListEngagements } from "@workspace/api-client-react";
import { Link } from "wouter";
import { formatRelative, formatDate } from "@/lib/format";
import { AppLayout } from "@/components/layout/app-layout";
import { CreateEngagementDialog } from "@/components/engagements/create-engagement-dialog";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendarDays, Users } from "lucide-react";

export default function EngagementsList() {
  const { data: engagements, isLoading } = useListEngagements();

  return (
    <AppLayout>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Engagements</h1>
          <p className="text-muted-foreground mt-1">Manage your active and past client diagnostics.</p>
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
            You don't have any active engagements yet. Create a new engagement to start assessing.
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
                    <Badge variant={
                      engagement.status === 'active' ? 'default' :
                      engagement.status === 'collecting' ? 'secondary' :
                      engagement.status === 'archived' ? 'outline' : 'outline'
                    } className="capitalize">
                      {engagement.status.replace('_', ' ')}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="py-4">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="text-muted-foreground mb-1 text-xs uppercase tracking-wider font-semibold">Teams</p>
                      <p className="font-medium font-mono">{engagement.teamCount}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground mb-1 text-xs uppercase tracking-wider font-semibold">Target Date</p>
                      <p className="font-medium">{engagement.targetDeliveryDate ? formatDate(engagement.targetDeliveryDate) : 'Not set'}</p>
                    </div>
                  </div>
                </CardContent>
                <CardFooter className="py-3 px-6 border-t bg-muted/5 text-xs text-muted-foreground flex justify-between">
                  <span>Created {formatRelative(engagement.createdAt)}</span>
                  <span className="group-hover:text-primary transition-colors font-medium">View details &rarr;</span>
                </CardFooter>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </AppLayout>
  );
}
