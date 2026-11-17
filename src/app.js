import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import multipart from "@fastify/multipart";
import Fastify from "fastify";

import { countFiles } from "./db.js";
import {
  fileExists,
  hashFile,
  isIdentifier,
  listStoredFiles,
  probeWritable,
  removeQuietly,
  storedPath,
  temporaryPath,
} from "./storage.js";

const maximumFileNameLength = 255;

export async function buildApp({ config, database, storage }) {
  const app = Fastify({
    logger: { level: config.logLevel },
    logController: new Fastify.LogController({ disableRequestLogging: true }),
  });

  await app.register(multipart, {
    limits: {
      fields: 4,
      fileSize: config.maximumUploadBytes,
      files: 1,
    },
  });

  app.setErrorHandler((error, request, reply) => {
    if (error.code === "FST_REQ_FILE_TOO_LARGE" || error.code === "FST_FILES_LIMIT") {
      request.log.warn({ code: error.code, url: request.url }, "upload rejected");
      return reply.code(413).send({ error: "file exceeds the upload limit", limit_bytes: config.maximumUploadBytes });
    }
    const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (statusCode >= 500) {
      request.log.error({ err: error, url: request.url }, "request failed");
      return reply.code(statusCode).send({ error: "internal error" });
    }
    return reply.code(statusCode).send({ error: error.message });
  });

  app.get("/", async () => ({
    name: "meshbay-sample-uploads",
    version: config.appVersion,
    data_dir: storage.dataDir,
    endpoints: [
      "GET /health",
      "GET /api/files",
      "POST /api/files",
      "GET /api/files/:id",
      "GET /api/files/:id/meta",
      "DELETE /api/files/:id",
      "GET /api/integrity",
    ],
  }));

  app.get("/health", async (request, reply) => {
    const writable = await probeWritable(storage.dataDir);
    let databaseFiles = null;
    let databaseError = null;
    try {
      databaseFiles = await countFiles(database);
    } catch (error) {
      databaseError = error.message;
      request.log.error({ err: error }, "health: database unreachable");
    }
    let diskFiles = null;
    let diskError = null;
    try {
      diskFiles = (await listStoredFiles(storage.dataDir)).length;
    } catch (error) {
      diskError = error.message;
      request.log.error({ err: error }, "health: data directory unreadable");
    }
    const healthy = writable.writable && databaseFiles !== null && diskFiles !== null;
    const payload = {
      status: healthy ? "ok" : "degraded",
      version: config.appVersion,
      host: os.hostname(),
      uptime_seconds: Math.round(process.uptime()),
      data_dir: storage.dataDir,
      data_dir_requested: storage.requestedDir,
      data_dir_fallback: storage.fallback,
      data_dir_write_error: storage.writeError,
      data_dir_writable: writable.writable,
      file_limit_bytes: config.maximumUploadBytes,
      disk_files: diskFiles,
      db_files: databaseFiles,
      files_consistent: diskFiles !== null && databaseFiles !== null && diskFiles === databaseFiles,
    };
    if (databaseError) {
      payload.database_error = databaseError;
    }
    if (diskError) {
      payload.data_dir_error = diskError;
    }
    return reply.code(healthy ? 200 : 503).send(payload);
  });

  app.get("/api/files", async () => {
    const result = await database.query(
      "SELECT id, name, size_bytes, sha256, content_type, created_at FROM files ORDER BY created_at, id",
    );
    return result.rows.map(toFileRecord);
  });

  app.post("/api/files", async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(415).send({ error: "content-type must be multipart/form-data" });
    }
    let part;
    try {
      part = await request.file();
    } catch (error) {
      if (error.code === "FST_REQ_FILE_TOO_LARGE" || error.code === "FST_FILES_LIMIT") {
        return reply.code(413).send({ error: "file exceeds the upload limit", limit_bytes: config.maximumUploadBytes });
      }
      throw error;
    }
    if (!part) {
      return reply.code(400).send({ error: 'multipart field "file" is required' });
    }

    const identifier = randomUUID();
    const incomingPath = temporaryPath(storage.dataDir, identifier);
    try {
      await pipeline(part.file, createWriteStream(incomingPath, { flags: "wx" }));
      if (part.file.truncated) {
        throw Object.assign(new Error("file exceeds the upload limit"), { code: "FST_REQ_FILE_TOO_LARGE" });
      }
    } catch (error) {
      await removeQuietly(incomingPath, request.log);
      if (error.code === "FST_REQ_FILE_TOO_LARGE" || error.code === "FST_FILES_LIMIT") {
        return reply.code(413).send({ error: "file exceeds the upload limit", limit_bytes: config.maximumUploadBytes });
      }
      throw error;
    }

    const name = normalizeFileName(part.filename, identifier);
    const contentType = normalizeContentType(part.mimetype);
    const sizeBytes = (await stat(incomingPath)).size;
    const sha256 = await hashFile(incomingPath);
    const finalPath = storedPath(storage.dataDir, identifier);
    await rename(incomingPath, finalPath);

    let row;
    try {
      const result = await database.query(
        `INSERT INTO files (id, name, size_bytes, sha256, content_type)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, size_bytes, sha256, content_type, created_at`,
        [identifier, name, sizeBytes, sha256, contentType],
      );
      row = result.rows[0];
    } catch (error) {
      await removeQuietly(finalPath, request.log);
      throw error;
    }

    request.log.info({ id: identifier, name, sizeBytes, sha256 }, "file stored");
    return reply.code(201).send(toFileRecord(row));
  });

  app.get("/api/files/:id/meta", async (request, reply) => {
    const identifier = validatedIdentifier(request, reply, request.params.id);
    if (!identifier) {
      return reply;
    }
    const result = await database.query(
      "SELECT id, name, size_bytes, sha256, content_type, created_at FROM files WHERE id = $1",
      [identifier],
    );
    if (result.rowCount === 0) {
      return reply.code(404).send({ error: "file not found" });
    }
    return toFileRecord(result.rows[0]);
  });

  app.get("/api/files/:id", async (request, reply) => {
    const identifier = validatedIdentifier(request, reply, request.params.id);
    if (!identifier) {
      return reply;
    }
    const result = await database.query(
      "SELECT id, name, size_bytes, sha256, content_type, created_at FROM files WHERE id = $1",
      [identifier],
    );
    if (result.rowCount === 0) {
      return reply.code(404).send({ error: "file not found" });
    }
    const record = toFileRecord(result.rows[0]);
    const filePath = storedPath(storage.dataDir, identifier);
    const present = await fileExists(filePath);
    if (!present.exists) {
      request.log.error({ id: identifier }, "file is in the database but missing on disk");
      return reply.code(500).send({
        error: "file_missing_on_disk",
        message: "the metadata row exists but the file is not in DATA_DIR",
        id: identifier,
        data_dir: storage.dataDir,
      });
    }
    reply.header("content-type", record.content_type ?? "application/octet-stream");
    reply.header("content-length", String(present.size));
    reply.header("content-disposition", contentDisposition(record.name));
    reply.header("x-file-sha256", record.sha256);
    return reply.send(createReadStream(filePath));
  });

  app.delete("/api/files/:id", async (request, reply) => {
    const identifier = validatedIdentifier(request, reply, request.params.id);
    if (!identifier) {
      return reply;
    }
    const result = await database.query("DELETE FROM files WHERE id = $1 RETURNING id", [identifier]);
    if (result.rowCount === 0) {
      return reply.code(404).send({ error: "file not found" });
    }
    await removeQuietly(storedPath(storage.dataDir, identifier), request.log);
    request.log.info({ id: identifier }, "file deleted");
    return reply.code(204).send();
  });

  app.get("/api/integrity", async (request, reply) => {
    const deep = ["1", "true", "yes"].includes(String(request.query?.deep ?? "").toLowerCase());
    const result = await database.query("SELECT id, name, size_bytes, sha256, created_at FROM files ORDER BY created_at, id");
    const rows = result.rows.map(toFileRecord);
    const knownIdentifiers = new Set(rows.map((row) => row.id));
    const disk = await listStoredFiles(storage.dataDir);
    const onDisk = new Map(disk.map((entry) => [entry.name, entry]));

    const missing = rows.filter((row) => !onDisk.has(row.id));
    const orphans = disk.filter((entry) => !knownIdentifiers.has(entry.name));
    const sizeMismatch = rows
      .filter((row) => onDisk.has(row.id) && onDisk.get(row.id).size !== row.size)
      .map((row) => ({
        id: row.id,
        name: row.name,
        db_size: row.size,
        disk_size: onDisk.get(row.id).size,
      }));

    const corrupt = [];
    if (deep) {
      for (const row of rows) {
        if (!onDisk.has(row.id)) {
          continue;
        }
        const actual = await hashFile(storedPath(storage.dataDir, row.id));
        if (actual !== row.sha256) {
          corrupt.push({ id: row.id, name: row.name, expected_sha256: row.sha256, actual_sha256: actual });
        }
      }
      for (const entry of orphans) {
        const actual = await hashFile(storedPath(storage.dataDir, entry.name));
        corrupt.push({ file: entry.name, expected_sha256: null, actual_sha256: actual, orphan: true });
      }
    }

    const healthy = missing.length === 0 && orphans.length === 0 && sizeMismatch.length === 0 && corrupt.length === 0;
    return reply.send({
      status: healthy ? "ok" : "drift",
      data_dir: storage.dataDir,
      data_dir_requested: storage.requestedDir,
      data_dir_fallback: storage.fallback,
      deep,
      disk_files: disk.length,
      db_files: rows.length,
      missing: missing.map((row) => ({ id: row.id, name: row.name, size_bytes: row.size, sha256: row.sha256 })),
      orphans: orphans.map((entry) => ({ file: entry.name, size_bytes: entry.size })),
      size_mismatch: sizeMismatch,
      corrupt,
    });
  });

  return app;
}

function validatedIdentifier(request, reply, rawIdentifier) {
  if (!isIdentifier(rawIdentifier)) {
    reply.code(400).send({ error: "file id must be a uuid" });
    return null;
  }
  return rawIdentifier;
}

function toFileRecord(row) {
  return {
    id: row.id,
    name: row.name,
    size: Number(row.size_bytes),
    sha256: row.sha256,
    content_type: row.content_type ?? null,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

function normalizeFileName(candidate, identifier) {
  const replaced = String(candidate ?? "").replaceAll("\\", "/");
  const base = path.basename(replaced).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (base === "" || base === "." || base === "..") {
    return `upload-${identifier}`;
  }
  return base.slice(0, maximumFileNameLength);
}

function normalizeContentType(candidate) {
  const value = String(candidate ?? "").trim();
  return value === "" ? "application/octet-stream" : value;
}

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replaceAll('"', "_").replaceAll("\\", "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
