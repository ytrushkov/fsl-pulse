import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import healthRouter from "./health";
import engagementsRouter from "./engagements";
import connectorsRouter from "./connectors";
import surveyRouter from "./survey";
import interviewsRouter from "./interviews";
import artifactsRouter from "./artifacts";
import evidenceRouter from "./evidence";
import scoringRouter from "./scoring";
import rubricsRouter from "./rubrics";
import deliverablesRouter from "./deliverables";
import exportsRouter from "./exports";
import aiRouter from "./ai";
import {
  requireAuth,
  requireEngagementMember,
  requirePulseAdmin,
} from "../middlewares/auth";

const router: IRouter = Router();

// Paths that bypass authentication. Magic-link respondent endpoints stay
// anonymous by design; the health probe is unauthenticated.
function isPublicPath(p: string): boolean {
  if (p === "/health" || p === "/healthz") return true;
  if (p.startsWith("/survey/respond/")) return true;
  return false;
}

// Step 1: enforce auth on every non-public path before any handler runs.
router.use((req: Request, res: Response, next: NextFunction) => {
  if (isPublicPath(req.path)) return next();
  return requireAuth(req, res, next);
});

// Step 2: enforce engagement membership on any `/engagements/:id/...` path.
const ENGAGEMENT_PATH = /^\/engagements\/([^/]+)(\/|$)/;
router.use((req: Request, res: Response, next: NextFunction) => {
  if (isPublicPath(req.path)) return next();
  const m = ENGAGEMENT_PATH.exec(req.path);
  if (!m) return next();
  // requireEngagementMember reads `req.params.id` — set it explicitly since
  // we are matching at the wrapper layer rather than via a route param.
  (req.params as Record<string, string>).id = m[1] ?? "";
  return requireEngagementMember(req, res, next);
});

router.use(healthRouter);
router.use(engagementsRouter);
router.use(connectorsRouter);
router.use(surveyRouter);
router.use(interviewsRouter);
router.use(artifactsRouter);
router.use(evidenceRouter);
router.use(scoringRouter);
// Rubric authoring is practice-wide and affects every engagement, so all
// /rubrics* mutations require the practice-admin guard. GETs stay
// auth-only so any assessor can see which rubric versions exist.
router.use(
  "/rubrics",
  (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    return requirePulseAdmin(req, res, next);
  },
);
router.use(rubricsRouter);
router.use(deliverablesRouter);
router.use(exportsRouter);
router.use(aiRouter);

export default router;
