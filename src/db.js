import pg from "pg";

const { Pool } = pg;

const schemaStatement = `
CREATE TABLE IF NOT EXISTS files (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  content_type text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS files_sha256_index ON files (sha256);
`;

export function createPool(databaseUrl) {
  return new Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 10000,
  });
}

export async function migrate(database) {
  await database.query(schemaStatement);
}

export async function countFiles(database) {
  const result = await database.query("SELECT count(*)::int AS total FROM files");
  return result.rows[0].total;
}
