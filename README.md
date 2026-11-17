# meshbay-sample-toml-dockerfile-uploads

Dockerfile variant of [Meshbay sample: uploads](https://github.com/renakaagusta/meshbay-sample-uploads): same Fastify
service, but it builds from [`Dockerfile`](Dockerfile) instead of Railpack. Two `node:22.21.1-alpine3.22` stages:
the first installs production dependencies only, the second copies them plus `src/` into a non-root runtime image,
creates `/data` owned by that user (the mount point of the `uploads` volume), exposes 8080 and starts
`node src/server.js` as `CMD` (the old Railpack `start`). The schema is still created on boot, so the manifest keeps
no `pre_deploy`.

A single Node 22 (Fastify) service that stores uploaded files in `DATA_DIR` and their metadata in Postgres.
It exists to test the Meshbay features a file-storing app needs: a data directory that survives a redeploy,
a database that can be backed up, wiped and restored, and (eventually) a database branch.

The app never trusts the disk: `GET /health` compares the files on disk with the rows in the database, and
`GET /api/integrity` lists every file that is missing on disk or orphaned on disk.

## Environment

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | yes | none | Postgres connection string. In Meshbay, wire it as a variable that references the project database, e.g. `${{<project>-postgres.DATABASE_URL}}` |
| `PORT` | no | `8080` | HTTP port. Meshbay injects `PORT` = the ingress port of the service |
| `DATA_DIR` | no | `/data` | Directory for the file bodies. Created on boot. Falls back to `<cwd>/.data` when it cannot be written, and reports that in `/health` (`data_dir_fallback`, `data_dir_write_error`) |
| `APP_VERSION` | no | `v1` | Reported by `/health`; bump it to prove a redeploy landed |
| `LOG_LEVEL` | no | `info` | Fastify (pino) log level. Logs go to stdout/stderr |

The upload limit is a fixed 10 MiB (`maximumUploadBytes` in `src/config.js`) and is reported by `/health` as
`file_limit_bytes`.

## Run locally

```sh
npm ci
createdb uploads
DATABASE_URL=postgres://postgres:postgres@localhost:5432/uploads DATA_DIR=./.data node src/server.js
```

The `files` table is created on boot when it is missing (`CREATE TABLE IF NOT EXISTS`), so a fresh database
works without a manual migration. `npm run migrate` (`scripts/migrate.js`) applies the same schema and is meant
for a `pre_deploy` hook (see [Known Meshbay gaps](#known-meshbay-gaps)).

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/` | Names, version, `DATA_DIR` and the endpoint list |
| GET | `/health` | `200` when the database answers and `DATA_DIR` is writable, `503` otherwise. Includes `host`, `uptime_seconds`, `data_dir`, `data_dir_writable`, `disk_files`, `db_files`, `files_consistent` |
| GET | `/api/files` | JSON array of metadata rows (`id`, `name`, `size`, `sha256`, `content_type`, `created_at`) |
| POST | `/api/files` | `multipart/form-data` with one file part (field name is not checked, `file` by convention) → `201` with the metadata row. `413` above 10 MiB, `415` for a non-multipart body |
| GET | `/api/files/:id` | Downloads the file (`200`, `content-disposition: attachment`, `x-file-sha256` header). `404` when the row does not exist, `500 {"error":"file_missing_on_disk"}` when the row exists but the file does not |
| GET | `/api/files/:id/meta` | The metadata row only (`200` or `404`) |
| DELETE | `/api/files/:id` | Deletes the row and the file (`204`, `404` when the row does not exist) |
| GET | `/api/integrity` | Compares disk with the database: `missing` (row without a file), `orphans` (file without a row), `size_mismatch`, and with `?deep=1` also `corrupt` (sha256 recomputed). `status` is `ok` or `drift` |

```sh
curl localhost:8080/health
curl -F file=@notes.txt localhost:8080/api/files
curl -OJ localhost:8080/api/files/<id>
curl localhost:8080/api/files/<id>/meta
curl localhost:8080/api/integrity
curl localhost:8080/api/integrity?deep=1
curl -X DELETE localhost:8080/api/files/<id>
```

## Meshbay deploy

`meshbay.toml` declares one service (`app`) on port 8080, one replica, a `/health` healthcheck and builds it from
`Dockerfile`. Steps for the coordinator:

1. Create the project from `https://github.com/renakaagusta/meshbay-sample-toml-dockerfile-uploads` (branch `main`).
2. Add a Postgres database to the project.
3. Add a variable on the `app` service: `DATABASE_URL` = `${{<project>-postgres.DATABASE_URL}}`.
4. Deploy, then run `bash scripts/smoke.sh https://<domain>` — it ends with `OK`.
5. Check `GET /health`: `data_dir` should be `/data`, `data_dir_fallback` should be `false`, and
   `disk_files` should equal `db_files`.

Do **not** raise `replicas` above 1: each container has its own `DATA_DIR`, so two replicas see two different
sets of files (this is the gap in [Known Meshbay gaps](#known-meshbay-gaps), not a bug in the app).

## Smoke script

```sh
bash scripts/smoke.sh https://<domain>
```

It uploads a random file (`SMOKE_BYTES` bytes, default 262144), downloads it, compares the sha256 of the
downloaded bytes with the local file and with the metadata row, checks `/api/integrity`, uploads a second file
and deletes it again, then prints the kept file id and sha256 and ends with `OK`. The uploaded file is kept on
purpose so the redeploy check below has something to verify.

```sh
bash scripts/smoke.sh https://<domain> --after-redeploy <id> <sha256>
```

Checks that the file from an earlier run is still downloadable after a redeploy/restart and still has the same
sha256. Use it right after every redeploy, restart and database restore.

`SMOKE_ALLOW_DRIFT=1` makes the fresh check ignore unrelated pre-existing drift (missing/orphan entries that are
not the file this run uploaded), useful after deliberately breaking the data directory in scenario 5.
`SMOKE_LIMIT_CHECK=1` additionally uploads an 11 MiB file and expects `413`.

## Test scenarios

Numbers are the order to run them in on a fresh project. Every scenario is a Meshbay observation, not a repo
change; record the result in the ticket.

### 1. First deploy and upload/download

```sh
bash scripts/smoke.sh https://<domain>
curl -s https://<domain>/health | jq
```

Expected: smoke prints `OK`; `/health` is `200`, `data_dir_fallback: false`, `files_consistent: true`.

### 2. Redeploy / restart keeps the files

```sh
bash scripts/smoke.sh https://<domain>        # note "file id" and "sha256" from the output
# redeploy the same commit (or restart the service) through Meshbay
bash scripts/smoke.sh https://<domain> --after-redeploy <id> <sha256>
```

Expected if `DATA_DIR` is persistent: `OK`, and `/health` now shows a different `host` (new container).
Expected today, without a volume: `GET /api/files/<id>/meta` still returns the row (the database kept it) but the
download answers `500 file_missing_on_disk` and `/api/integrity` lists the id under `missing`. That is gap G1/G2.

### 3. Same app on another machine

Move the service to another cluster machine (or scale to 2 replicas for a moment) and repeat scenario 2.
Each container gets its own `DATA_DIR`, so a request can hit a container that never saw the file: expect
`500 file_missing_on_disk` on the download and `missing` entries in `/api/integrity`, while `/health` on the two
replicas reports different `disk_files` counts.

### 4. Backup → delete → restore the database

Keep the file bodies (they live on the data directory) and exercise the database side only:

```sh
pg_dump "$DATABASE_URL" --no-owner --format=custom --file=uploads.dump      # backup
curl -s https://<domain>/api/files | jq -r '.[].id'                          # note the ids
psql "$DATABASE_URL" -c 'DELETE FROM files'                                  # simulate data loss
curl -s https://<domain>/api/integrity | jq                                  # every file is now an orphan
pg_restore --clean --no-owner --dbname="$DATABASE_URL" uploads.dump          # restore
curl -s https://<domain>/api/integrity | jq                                  # status: ok again
bash scripts/smoke.sh https://<domain> --after-redeploy <id> <sha256>        # still OK
```

Expected: while the table is empty, `/api/integrity` reports the files as `orphans` and `/health` shows
`disk_files > db_files` with `files_consistent: false` (health stays `200` on purpose — a metadata/disk
mismatch must not make the platform restart the container in a loop). After the restore, both sides match again.

The same backup can be taken from the Meshbay database UI. A **filesystem** backup of `DATA_DIR` is what is
missing today: a database backup alone cannot restore a file whose body was on the container disk (gap G6).

### 5. Deliberate disk drift

Inside the container (Meshbay exec / a shell on the machine):

```sh
rm /data/<id>                 # missing: row without a file
echo stray > /data/stray.bin  # orphan: file without a row
curl -s https://<domain>/api/integrity | jq
```

Expected: the removed id appears under `missing`, `stray.bin` under `orphans`, `status: drift`. Uploading again
works; `SMOKE_ALLOW_DRIFT=1 bash scripts/smoke.sh https://<domain>` still ends with `OK`.

### 6. Database branch

Create a branch of the project database (Meshbay database branch feature), point a second environment/service at
the branch through `DATABASE_URL`, deploy it, and check the pair:

```sh
curl -s https://<branch-domain>/api/files | jq        # the rows from the branch
curl -s https://<branch-domain>/api/integrity | jq    # rows without files = the branch cannot see the parent's DATA_DIR
```

Expected: a database branch carries the metadata but not the files, so `/api/integrity` reports every row as
`missing` unless the branch runs next to the same data directory. This is the observation the ticket is after.

### 7. Upload limit

```sh
SMOKE_LIMIT_CHECK=1 bash scripts/smoke.sh https://<domain>
```

Expected: an 11 MiB upload answers `413` and nothing is written to `DATA_DIR` or the `files` table
(`/health` counts stay equal).

## Known Meshbay gaps

Found while writing this sample, from reading `~/Documents/project/meshbay` at commit `main` on 2026-11-15.
Each one is a candidate ticket; none is worked around silently in this repo.

**G1 — no volume key in `meshbay.toml`.** `manifest.Service`
(`apps/api/internal/application/manifest/manifest.go`) has no `volumes` field and `manifest.Parse` runs with
`DisallowUnknownFields`, so `volumes = ["/data"]` is a parse error. `DATA_DIR` therefore lives in the container
filesystem and is lost when the container is replaced. Proposed key: `volumes = ["/data"]` (container path, named
`<service>-data`), rendered into `spec.Volumes` / `spec.Container.VolumeMounts` the way
`apps/api/internal/application/apptemplates/deploy.go:249` already does for template apps.

**G2 — volumes exist only for app templates.** `domain.ServiceVolume` and the cluster writer
(`clusterwriter/uncloud/spec.go:139`) support volumes, but the only producer outside tests is
`application/apptemplates` (`domain/app_template.go:248`, `apptemplates/deploy.go:249`) plus the runner
(`runner/provision.go:85`). A service deployed from a repository has no path to a volume, in the manifest, the UI
or the API. The dashboard already tells users "Removing it deletes the running service and keeps its volumes"
(`ServiceSettingsTab.tsx:260`), which does not hold for a repo service that never got one.

**G3 — `[services.env]` does not survive a variable change.** The manifest env is rendered into the compose
environment, but `variablesSpec` (`clusterwriter/uncloud/writer.go:187`,
`clusterwriter/uncloud/spec.go:266`) rebuilds `Container.Env` from the user variables plus `MESHBAY_*` only, so a
manifest `DATA_DIR`/`APP_VERSION` disappears after the first variable edit. This sample therefore hard-codes safe
defaults in code instead of relying on the manifest env; `PORT` is injected by Meshbay and is read as-is.

**G4 — `replicas > 1` with local state.** Nothing stops `replicas = 3` for a service that writes to `DATA_DIR`;
each replica then has its own files and requests are load-balanced across them. Needs either a volume per replica
with shared storage or a validation warning.

**G5 — `pre_deploy` env is unverified.** The manifest renders `x-pre_deploy` (`manifest/compose.go:156`), but it is
not documented whether that hook receives the service variables (`DATABASE_URL`). This sample migrates on boot so
a deploy cannot fail on that; `scripts/migrate.js` is ready to be wired as `pre_deploy = "node scripts/migrate.js"`
once the hook is known to see `DATABASE_URL`.

**G6 — no filesystem backup/restore.** The platform backs up databases, not a service's data directory, so
"backup → delete → restore" can only cover the metadata until G1/G2 land. Scenario 4 shows the split.

`meshbay.toml` also accepts `domains`; this sample leaves it out on purpose and uses the domain the deployment is
given, so the smoke command works without any DNS setup.


## Repository layout

```
src/server.js      boot: config, migrate, open DATA_DIR, listen, graceful shutdown
src/app.js         Fastify app and routes
src/storage.js     DATA_DIR helpers (open/probe, paths, sha256, disk listing)
src/db.js          pg pool, schema
src/config.js      env parsing and the 10 MiB limit
scripts/migrate.js schema migration entry point (pre_deploy candidate)
scripts/smoke.sh   live check, `OK` on success
meshbay.toml       service declaration
```

## Local checks

```sh
node --check src/server.js && node --check src/app.js && node --check src/storage.js
node --check src/db.js && node --check src/config.js && node --check scripts/migrate.js
bash -n scripts/smoke.sh
python3 -c 'import tomllib,sys; tomllib.load(open("meshbay.toml","rb"))'
```
