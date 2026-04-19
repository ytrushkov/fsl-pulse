import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, interviewsTable } from "@workspace/db";
import { paramId } from "../lib/util";
import { suggestInterviewTagsAi } from "../lib/ai-deliverables";
import { requireResourceMember } from "../middlewares/auth";
import { recordActivity } from "../lib/audit";

const router: IRouter = Router();

const requireInterviewMember = requireResourceMember({
  paramName: "interviewId",
  resolveEngagementId: async (interviewId) => {
    const [row] = await db
      .select({ engagementId: interviewsTable.engagementId })
      .from(interviewsTable)
      .where(eq(interviewsTable.id, interviewId));
    return row?.engagementId;
  },
});

router.post(
  "/interviews/:interviewId/ai-suggest",
  requireInterviewMember,
  async (req, res): Promise<void> => {
    const id = paramId(req.params.interviewId);
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [iv] = await db
      .select()
      .from(interviewsTable)
      .where(eq(interviewsTable.id, id));
    if (!iv) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const out = await suggestInterviewTagsAi(iv.notes, {
      requestId: (req as typeof req & { id?: string }).id,
    });
    await recordActivity(req, {
      engagementId: iv.engagementId,
      kind: "ai_suggest",
      message: `Requested AI tag suggestions for interview with ${iv.interviewee}`,
      payload: {
        interviewId: iv.id,
        suggestionCount: out.suggestions.length,
      },
    });
    res.json(out);
  },
);

export default router;
