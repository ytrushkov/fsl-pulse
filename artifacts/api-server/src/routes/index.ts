import { Router, type IRouter } from "express";
import healthRouter from "./health";
import engagementsRouter from "./engagements";
import connectorsRouter from "./connectors";
import surveyRouter from "./survey";
import interviewsRouter from "./interviews";
import artifactsRouter from "./artifacts";
import evidenceRouter from "./evidence";
import scoringRouter from "./scoring";
import deliverablesRouter from "./deliverables";
import exportsRouter from "./exports";
import aiRouter from "./ai";

const router: IRouter = Router();

router.use(healthRouter);
router.use(engagementsRouter);
router.use(connectorsRouter);
router.use(surveyRouter);
router.use(interviewsRouter);
router.use(artifactsRouter);
router.use(evidenceRouter);
router.use(scoringRouter);
router.use(deliverablesRouter);
router.use(exportsRouter);
router.use(aiRouter);

export default router;
