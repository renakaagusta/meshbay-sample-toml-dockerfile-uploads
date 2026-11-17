import path from "node:path";

export const defaultPort = 8080;
export const defaultDataDir = "/data";
export const maximumUploadBytes = 10 * 1024 * 1024;

export function loadConfig(environment = process.env) {
  return {
    appVersion: text(environment.APP_VERSION) || "v1",
    databaseUrl: text(environment.DATABASE_URL),
    dataDir: path.resolve(text(environment.DATA_DIR) || defaultDataDir),
    logLevel: text(environment.LOG_LEVEL) || "info",
    maximumUploadBytes,
    port: parsePort(environment.PORT),
  };
}

function parsePort(rawValue) {
  const parsed = Number.parseInt(text(rawValue), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return defaultPort;
  }
  return parsed;
}

function text(rawValue) {
  return String(rawValue ?? "").trim();
}
