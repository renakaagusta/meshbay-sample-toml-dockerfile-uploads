import { loadConfig } from "./config.js";
import { createPool, migrate } from "./db.js";
import { openStorageDirectory } from "./storage.js";
import { buildApp } from "./app.js";

const config = loadConfig();
if (config.databaseUrl === "") {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const database = createPool(config.databaseUrl);
let app = null;

try {
  await migrate(database);
  const storage = await openStorageDirectory(config.dataDir);
  if (storage.fallback) {
    console.error(
      `DATA_DIR ${storage.requestedDir} is not writable (${storage.writeError}); ` +
        `storing files in ${storage.dataDir} instead. This directory is inside the container and disappears on redeploy.`,
    );
  }
  app = await buildApp({ config, database, storage });
  await app.listen({ host: "0.0.0.0", port: config.port });
  app.log.info(
    {
      version: config.appVersion,
      dataDir: storage.dataDir,
      dataDirRequested: storage.requestedDir,
      dataDirFallback: storage.fallback,
      fileLimitBytes: config.maximumUploadBytes,
    },
    "uploads service started",
  );
} catch (error) {
  console.error("startup failed:", error);
  await database.end().catch(() => {});
  process.exit(1);
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  await app.close().catch(() => {});
  await database.end().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
