import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// Accept incoming x-request-id from upstream proxies (so a caller can pre-mint
// a correlation id and trace it across services), otherwise generate a v4
// UUID. The same id is exposed on the response so clients/operators can
// quote it back when reporting issues.
function ensureRequestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers["x-request-id"];
  const provided = Array.isArray(incoming) ? incoming[0] : incoming;
  const safe =
    typeof provided === "string" && /^[A-Za-z0-9._:\-]{1,128}$/.test(provided)
      ? provided
      : randomUUID();
  (req as Request & { id: string }).id = safe;
  res.setHeader("x-request-id", safe);
  next();
}
app.use(ensureRequestId);

// Surface the request id on every error response so operators can correlate
// a user-reported failure with server logs without touching every route. We
// wrap res.json once per request — on status >= 400, if the body is a plain
// object that doesn't already include `requestId`, inject it.
app.use((req: Request, res: Response, next: NextFunction) => {
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    if (
      res.statusCode >= 400 &&
      body !== null &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      !(body as Record<string, unknown>).requestId
    ) {
      (body as Record<string, unknown>).requestId =
        (req as Request & { id?: string }).id ?? null;
    }
    return originalJson(body);
  };
  next();
});

app.use(
  pinoHttp({
    logger,
    // pino-http will respect req.id if it's already set by upstream middleware.
    genReqId: (req) => (req as Request & { id?: string }).id ?? randomUUID(),
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

// Restrict CORS to known origins. Reflecting arbitrary origins with
// credentials would be a CSRF risk on authenticated endpoints.
const allowedOrigins = new Set<string>(
  [
    process.env.PULSE_WEB_ORIGIN,
    process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : undefined,
    "http://localhost:5173",
    "http://localhost:3000",
  ].filter((s): s is string => Boolean(s)),
);
app.use(
  cors({
    credentials: true,
    origin: (origin, cb) => {
      // Same-origin / curl / server-to-server (no Origin header) are allowed.
      if (!origin) return cb(null, true);
      if (allowedOrigins.has(origin)) return cb(null, true);
      return cb(new Error(`Origin not allowed by CORS: ${origin}`));
    },
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(clerkMiddleware());

app.use("/api", router);

// Global JSON error handler — surfaces the request id so clients can quote
// it back when reporting issues, and logs the full error server-side. Keeps
// the response body shape consistent with route-level 4xx replies.
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);
  const requestId = (req as Request & { id?: string }).id ?? null;
  // Always log the full error server-side (with requestId for correlation),
  // but never leak internal error messages, stack traces, or query details
  // back to clients. Operators can quote the requestId to look up the
  // structured log line.
  logger.error({ err, requestId, url: req.url }, "Unhandled error");
  res.status(500).json({ error: "Internal Server Error", requestId });
});

export default app;
