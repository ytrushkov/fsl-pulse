import type { Request, Response, NextFunction } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { eq, and, or } from "drizzle-orm";
import {
  db,
  usersTable,
  engagementMembersTable,
} from "@workspace/db";

export interface AuthedUser {
  id: string;
  clerkUserId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authedUser?: AuthedUser;
    }
  }
}

async function loadOrUpsertUser(clerkUserId: string): Promise<AuthedUser> {
  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.clerkUserId, clerkUserId));
  let user = existing;

  // Pull fresh profile data from Clerk to keep name/email/avatar in sync.
  let profile: {
    email: string;
    name: string;
    avatarUrl: string | null;
  } | null = null;
  try {
    const cu = await clerkClient.users.getUser(clerkUserId);
    const primaryEmail =
      cu.emailAddresses.find((e) => e.id === cu.primaryEmailAddressId)
        ?.emailAddress ?? cu.emailAddresses[0]?.emailAddress ?? "";
    profile = {
      email: primaryEmail.toLowerCase(),
      name:
        [cu.firstName, cu.lastName].filter(Boolean).join(" ").trim() ||
        primaryEmail,
      avatarUrl: cu.imageUrl ?? null,
    };
  } catch {
    // Clerk lookup failed; fall back to whatever we have on record.
  }

  if (!user && profile) {
    // First sign-in: create user, and claim any pending memberships invited by email.
    const [created] = await db
      .insert(usersTable)
      .values({
        clerkUserId,
        email: profile.email,
        name: profile.name,
        avatarUrl: profile.avatarUrl,
      })
      .returning();
    user = created;
    await db
      .update(engagementMembersTable)
      .set({ userId: user.id })
      .where(
        and(
          eq(engagementMembersTable.email, profile.email),
        ),
      );
  } else if (user && profile) {
    const needsUpdate =
      user.email !== profile.email ||
      user.name !== profile.name ||
      user.avatarUrl !== profile.avatarUrl;
    if (needsUpdate) {
      const [updated] = await db
        .update(usersTable)
        .set({
          email: profile.email,
          name: profile.name,
          avatarUrl: profile.avatarUrl,
        })
        .where(eq(usersTable.id, user.id))
        .returning();
      user = updated;
    }
  }

  if (!user) {
    throw new Error("Unable to resolve user");
  }

  return {
    id: user.id,
    clerkUserId: user.clerkUserId ?? clerkUserId,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
  };
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (req.authedUser) {
    next();
    return;
  }
  const auth = getAuth(req);
  const clerkUserId = auth?.userId;
  if (!clerkUserId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    req.authedUser = await loadOrUpsertUser(clerkUserId);
    next();
  } catch (err) {
    req.log?.error({ err }, "Failed to resolve authed user");
    res.status(500).json({ error: "Auth resolution failed" });
  }
}

async function userIsMember(
  user: AuthedUser,
  engagementId: string,
): Promise<boolean> {
  const [member] = await db
    .select({ id: engagementMembersTable.id })
    .from(engagementMembersTable)
    .where(
      and(
        eq(engagementMembersTable.engagementId, engagementId),
        or(
          eq(engagementMembersTable.userId, user.id),
          eq(engagementMembersTable.email, user.email),
        ),
      ),
    )
    .limit(1);
  return Boolean(member);
}

/**
 * Generic resource-membership guard. Resolves the parent engagement id for the
 * resource referenced in the URL (connector / interview / artifact / evidence)
 * and ensures the authed user is a member of that engagement. Used to plug
 * IDOR holes on routes shaped like `/connectors/:connectorId`.
 */
export function requireResourceMember<R>(opts: {
  paramName: string;
  resolveEngagementId: (id: string) => Promise<string | null | undefined>;
}) {
  return async function (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const user = req.authedUser;
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const resourceId = req.params[opts.paramName];
    if (!resourceId) {
      res.status(400).json({ error: `Missing ${opts.paramName}` });
      return;
    }
    const engagementId = await opts.resolveEngagementId(resourceId);
    if (!engagementId) {
      res.status(404).json({ error: "Resource not found" });
      return;
    }
    if (!(await userIsMember(user, engagementId))) {
      res.status(403).json({ error: "Not a member of this engagement" });
      return;
    }
    next();
  } satisfies (req: Request, res: Response, next: NextFunction) => Promise<void>;
}

/**
 * Require that the authed user is a member of the engagement specified by `:id`
 * in the route params. Must run after `requireAuth`.
 */
export async function requireEngagementMember(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const user = req.authedUser;
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const engagementId = req.params["id"];
  if (!engagementId) {
    res.status(400).json({ error: "Missing engagement id" });
    return;
  }
  if (!(await userIsMember(user, engagementId))) {
    res.status(403).json({ error: "Not a member of this engagement" });
    return;
  }
  next();
}
