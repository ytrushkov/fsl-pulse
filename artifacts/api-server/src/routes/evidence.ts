import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, evidenceTable } from "@workspace/db";
import { paramId } from "../lib/util";

const router: IRouter = Router();

router.get("/engagements/:id/evidence", async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const rows = await db
    .select()
    .from(evidenceTable)
    .where(eq(evidenceTable.engagementId, id))
    .orderBy(desc(evidenceTable.createdAt));
  res.json(rows);
});

export default router;
