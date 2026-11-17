import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const incomingDirectoryName = ".incoming";

const identifierPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Opens DATA_DIR, falling back to a writable directory inside the working
 * directory when the requested one cannot be created or written to. Meshbay
 * cannot attach a volume to a repo-deployed service yet, so the fallback keeps
 * the service alive and reports the problem through GET /health instead of
 * crash-looping.
 */
export async function openStorageDirectory(requestedDir) {
  try {
    return await prepare(requestedDir);
  } catch (error) {
    const fallbackDir = path.resolve(process.cwd(), ".data");
    if (fallbackDir === requestedDir) {
      throw error;
    }
    const prepared = await prepare(fallbackDir);
    return { ...prepared, fallback: true, requestedDir, writeError: error.message };
  }
}

async function prepare(dataDir) {
  await mkdir(dataDir, { recursive: true });
  await mkdir(path.join(dataDir, incomingDirectoryName), { recursive: true });
  const probe = await probeWritable(dataDir);
  if (!probe.writable) {
    throw new Error(probe.error);
  }
  return { dataDir, fallback: false, requestedDir: dataDir, writeError: null };
}

export async function probeWritable(directory) {
  const probePath = path.join(directory, `.probe-${process.pid}-${Date.now()}`);
  try {
    await writeFile(probePath, "ok");
    await unlink(probePath);
    return { writable: true, error: null };
  } catch (error) {
    return { writable: false, error: error.message };
  }
}

export function storedPath(dataDir, identifier) {
  return path.join(dataDir, identifier);
}

export function temporaryPath(dataDir, identifier) {
  return path.join(dataDir, incomingDirectoryName, identifier);
}

export function isIdentifier(value) {
  return typeof value === "string" && identifierPattern.test(value);
}

/** Files stored on disk, ignoring the incoming directory and dotfiles. */
export async function listStoredFiles(dataDir) {
  const entries = await readdir(dataDir, { withFileTypes: true });
  const stored = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".")) {
      continue;
    }
    const stats = await stat(path.join(dataDir, entry.name));
    stored.push({ name: entry.name, size: stats.size });
  }
  return stored.sort((left, right) => left.name.localeCompare(right.name));
}

export async function hashFile(filePath) {
  const digest = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return digest.digest("hex");
}

export async function removeQuietly(filePath, log) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT" && log) {
      log.warn({ err: error, file: filePath }, "could not remove file");
    }
  }
}

export async function fileExists(filePath) {
  try {
    const stats = await stat(filePath);
    return { exists: true, size: stats.size };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { exists: false, size: 0 };
    }
    throw error;
  }
}
