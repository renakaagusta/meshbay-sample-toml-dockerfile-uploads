import { loadConfig } from "../src/config.js";
import { createPool, migrate } from "../src/db.js";

// Standalone migration entry point. The service also creates its schema on
// boot; this script exists so the schema can run from a pre_deploy hook once
// Meshbay passes the service variables (DATABASE_URL) to that step.
const config = loadConfig();
if (config.databaseUrl === "") {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const database = createPool(config.databaseUrl);
try {
  await migrate(database);
  console.log("migrate ok");
} catch (error) {
  console.error("migrate failed:", error.message);
  process.exitCode = 1;
} finally {
  await database.end().catch(() => {});
}
