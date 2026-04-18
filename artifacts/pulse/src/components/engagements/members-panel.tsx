import { useState } from "react";
import {
  useListEngagementMembers,
  useAddEngagementMember,
  useRemoveEngagementMember,
  getListEngagementMembersQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UserPlus, Users, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type Role = "owner" | "assessor" | "viewer";

const ROLE_VARIANT: Record<Role, string> = {
  owner: "bg-primary/15 text-primary border-primary/40",
  assessor: "bg-accent/15 text-accent border-accent/40",
  viewer: "bg-muted text-muted-foreground border-border",
};

interface Props {
  engagementId: string;
}

export function MembersPanel({ engagementId }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("assessor");

  const { data: members, isLoading } = useListEngagementMembers(engagementId);

  const invalidate = () =>
    qc.invalidateQueries({
      queryKey: getListEngagementMembersQueryKey(engagementId),
    });

  const addMember = useAddEngagementMember({
    mutation: {
      onSuccess: () => {
        setEmail("");
        invalidate();
        toast({ title: "Invite sent", description: "The team member has been added." });
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "Could not add member";
        toast({ title: "Failed to add member", description: msg, variant: "destructive" });
      },
    },
  });

  const removeMember = useRemoveEngagementMember({
    mutation: {
      onSuccess: invalidate,
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "Could not remove member";
        toast({ title: "Failed to remove", description: msg, variant: "destructive" });
      },
    },
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Users className="h-5 w-5 text-accent" />
            Engagement team
          </CardTitle>
          <Badge variant="outline" className="bg-card">
            {members?.length ?? 0} members
          </Badge>
        </div>
        <CardDescription>
          Invite FullStack assessors. Only members can view and edit this engagement.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = email.trim().toLowerCase();
            if (!trimmed) return;
            addMember.mutate({ id: engagementId, data: { email: trimmed, role } });
          }}
        >
          <Input
            type="email"
            placeholder="teammate@fullstack.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="flex-1"
          />
          <Select value={role} onValueChange={(v) => setRole(v as Role)}>
            <SelectTrigger className="w-full sm:w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="owner">Owner</SelectItem>
              <SelectItem value="assessor">Assessor</SelectItem>
              <SelectItem value="viewer">Viewer</SelectItem>
            </SelectContent>
          </Select>
          <Button type="submit" disabled={addMember.isPending} className="gap-2">
            <UserPlus className="h-4 w-4" />
            Invite
          </Button>
        </form>

        <div className="divide-y divide-border rounded-lg border border-border">
          {isLoading ? (
            <div className="space-y-2 p-3">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : !members || members.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No members yet — invite your first teammate above.
            </p>
          ) : (
            members.map((m) => {
              const initials = (m.name ?? m.email)
                .split(/[\s@.]/)
                .filter(Boolean)
                .slice(0, 2)
                .map((s) => s[0]?.toUpperCase())
                .join("");
              return (
                <div
                  key={m.id}
                  className="flex items-center justify-between gap-3 px-3 py-2.5"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-bold">
                      {m.avatarUrl ? (
                        <img
                          src={m.avatarUrl}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        initials
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">
                        {m.name ?? m.email}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {m.email}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={`capitalize ${ROLE_VARIANT[m.role as Role] ?? ROLE_VARIANT.viewer}`}
                    >
                      {m.role}
                    </Badge>
                    {m.status === "pending" && (
                      <Badge variant="outline" className="text-xs">
                        pending
                      </Badge>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      disabled={removeMember.isPending}
                      onClick={() =>
                        removeMember.mutate({
                          id: engagementId,
                          memberId: m.id,
                        })
                      }
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </CardContent>
    </Card>
  );
}
