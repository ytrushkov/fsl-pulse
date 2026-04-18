import app from "./app";
import { logger } from "./lib/logger";
import { migrateLegacyConnectorTokens } from "./lib/migrations";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // One-shot upgrade: re-encrypt any connector tokens still stored in the
  // legacy base64 format into the v1 AES-GCM envelope. Idempotent and safe to
  // run on every boot. Logs a summary; failures are reported but don't crash
  // the server.
  migrateLegacyConnectorTokens()
    .then((summary) => {
      if (summary.migrated > 0 || summary.failed > 0) {
        logger.info(summary, "Legacy connector token migration completed");
      }
    })
    .catch((e) => logger.error({ err: e }, "Token migration failed"));
});
