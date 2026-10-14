# DevGuard

DevGuard includes a Vite/React dashboard and a real, deliberately narrow ESLint file-analysis API. The four example projects and their dashboard metrics remain **demo fixtures**. Signed-in users' saved projects and runs are separate. Tool findings are not confirmed vulnerabilities.

## Architecture

A **single persistent Node 22 service** serves `dist/` and `/api`. It forks a bounded ESLint child process per analysis and stores accounts, sessions, projects, runs and findings in SQLite on a **durable private disk**. Do not run multiple replicas against a network-mounted SQLite file; per-IP limits and concurrency are per Node process. The native SQLite module needs Node headers if no prebuilt binary is available; the Docker builder points node-gyp to the image's local headers. The database is necessary for identity, ownership and retrieval after restart. No source files are stored; only bounded finding details and evidence for literal `debugger;` are stored. An in-memory cache is not used for runs.

## Local setup

```bash
npm ci  # if native SQLite must compile offline: npm_config_nodedir=/usr/local npm ci
npm run build
DATA_DIR=./data PORT=3001 npm start
```

Open `http://localhost:3001/sign-in`, register using a unique email and password of 12–128 UTF-8 bytes, then navigate to **Analyze files**. Select `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts` or `.tsx` (for example, a file containing `debugger;`) and analyze it. The real finding is saved to your default **My uploads** project; choose another project if desired. Your saved runs appear on `/analysis`; your real projects appear above the separate demo projects on `/projects`. For development, use `npm run dev:api` and `npm run dev` in separate terminals; Vite proxies `/api` to port 3001. Keep `PUBLIC_ORIGIN` unset for local HTTP testing; the server uses the request Host for origin checks.

Run all checks:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:production
```

## Authentication and API

Passwords use Argon2id (`@node-rs/argon2`). A 32-byte random session token is stored as a SHA-256 digest in SQLite and sent only in an HttpOnly, SameSite=Lax cookie. In production set `COOKIE_SECURE=1` for the Secure, `__Host-` prefixed cookie. Sessions have a fixed seven-day expiration, no sliding renewal. Logout deletes the session and clears the cookie. `GET /api/session` returns the signed-in user and a per-session CSRF token; state-changing requests require both an exact same-origin `Origin` and `X-CSRF-Token`. Registration/login also require a valid Origin. Do not cache session responses. The CSRF token is not an authentication credential. The browser does not store the session token or a user ID in localStorage.

- `GET /api/health` — `{ "status": "ok" }`, no secrets.
- `POST /api/auth/register`, `POST /api/auth/login` — JSON `{ "email", "password" }`; response sets the cookie and returns `{ "user", "csrfToken" }`.
- `GET /api/session`, `POST /api/auth/logout`.
- `GET /api/projects`, `POST /api/projects` (JSON `{ "name" }`), `GET /api/projects/:id`.
- `POST /api/analyze` — multipart parts `files` (1–10) and optional `projectId` field; defaults to the user's newest project. Returns `{ "run" }` with tool metadata, status, timestamps, findings and safe errors.
- `GET /api/runs`, `GET /api/runs/:id`, `DELETE /api/runs/:id`.

All endpoints except health and registration/login require a valid server-side session. Each project and run read/write is scoped by the **session's** user ID in SQL; another user's IDs return 404. Finding details are returned only as part of the owned run. Projects are initialized with a default upload project on registration. Run deletion is permanent. A run interrupted by API restart is marked failed on startup. Findings and status changes are committed together in a transaction. Errors are structured JSON without stack traces or filesystem paths.

## Limits, retention and remaining risks

Uploads are limited to 10 files, 256 KiB each, 1 MiB aggregate content and 1.2 MiB whole request. Request JSON has a 16 KiB limit. Analysis runs up to 10 seconds per child process (128 MiB **V8 heap**, not total memory); request-body timeout is 15 seconds. Two analyses/uploads can be active per process; additional requests get 503. Uploads and auth each have five attempts per socket IP per minute; result reads have 60 per minute (429 and `Retry-After` when exceeded). Only fixed server-owned ESLint rules are used: `no-eval`, `no-implied-eval`, `no-debugger`, `eqeqeq`, `no-constant-condition`, `no-unreachable`, `no-unsafe-finally`, and JS-only `no-unused-vars` and `no-undef`. Uploaded code, config and plugins are never executed or loaded. These checks do not prove code is secure.

Sessions expire after seven days; runs older than **30 days** are pruned on startup and on analysis submission. Database backups and their retention must be handled by the operator; SQLite WAL sidecar files are part of the database state. Source-code-derived rule messages, paths and evidence can still be sensitive: use trusted users and encrypt disks/backups. No password reset, email verification, MFA, account deletion, account lockout or global distributed throttling exists. Password guessing protection is per socket IP only. The child inherits OS permissions but receives only a minimal PATH/NODE_ENV environment; it has no full CPU, total-memory or network sandbox. Deploy with host/container resource and network restrictions. Never treat passing tests as proof of production security.

## Deployment (prepared, **not deployed**)

Use the provided `Dockerfile` on a provider supporting persistent Node processes, subprocesses and a **single-instance private durable volume** mounted at `/data` writable by UID 1000. Set `PUBLIC_ORIGIN=https://your-real-host.example`, `COOKIE_SECURE=1`, `DATA_DIR=/data`, `PORT=3001`, and `NODE_ENV=production`. These are server-only settings; `.env.example` contains placeholders, not secrets. `PUBLIC_ORIGIN` must match the browser-visible origin exactly. The server fails startup in production if the origin, cookie setting or data directory is missing. Route HTTPS to port 3001 through a trusted TLS terminator, preserve the original Origin and Cookie headers, impose body/connection limits and edge rate limits. Do not trust client-supplied `X-Forwarded-For`; the application uses socket IP. Verify the mounted volume survives restarts, run backups, and ensure database migrations run on startup from `migrations/001_initial.sql` (SQLite user_version=1). Migration failures stop startup; back up the database before upgrades.

If using Vercel for the **static frontend only**, build `dist/` and configure an external same-origin rewrite of `/api/:path*` to this persistent Node origin (see [Vercel external rewrites](https://vercel.com/docs/routing/rewrites)). Use a deployment-specific `vercel.json` with your actual API hostname and SPA fallback. Set `PUBLIC_ORIGIN` to the Vercel frontend origin. The current API is **not** a Vercel Function. Protect the Node origin against bypass at the network/edge layer. A same-origin proxy is necessary for cookie auth; do not expose a browser-side API key or absolute cross-origin API URL. No hosting credentials were available here, so no cloud deployment is claimed.

Manual deployment verification: visit `/api/health`, register/sign in over HTTPS, upload `debugger;` and confirm a real `no-debugger` finding, fetch `/api/runs/:id` with the same session, restart the API and retrieve it again, verify another account gets 404 for the run, confirm a mutation without CSRF gets 403, and verify no auth cookie is readable from JavaScript. Do not invite public users before independent security review and infrastructure isolation.

## Phase 2F operator guide: controlled deployment

The image builds with Node 22, native SQLite build tools in the **build stage**, then runs as non-root UID/GID 1000 (`node`) with only port 3001 declared. The runtime entry point is Node directly, not `npm`, so the process receives SIGTERM/SIGINT. No container image was built or pushed in this workspace; validate the image on your chosen host before use.

### Host checklist

1. Provision **one** persistent Node-capable instance with a private, durable, local filesystem volume mounted at `/data`. Make it writable by UID 1000 and inaccessible to the public web server. Do **not** scale this SQLite service across replicas or use an unverified network filesystem. Reserve separate private storage for encrypted backups. Back up the whole data volume before upgrades.
2. Build the repository image using `docker build -t devguard:<version> .` on a host with Docker/compatible OCI tooling. Before exposing it, inspect native module loading and the image's actual UID with `docker run --rm --entrypoint id devguard:<version>`. Launch with a **named/bind persistent mount**, not an anonymous or container-only directory: `docker run --name devguard --restart unless-stopped --mount type=bind,src=/ABSOLUTE/PRIVATE/DATA,dst=/data -e PUBLIC_ORIGIN=https://YOUR-HOST.example -p 127.0.0.1:3001:3001 devguard:<version>`. Ensure the host directory exists and is owned by UID 1000. Do not use the illustrative hostname unchanged.
3. Terminate HTTPS at a trusted reverse proxy and send traffic to the private port. Preserve `Origin`, `Host`, `Cookie` and `Set-Cookie` headers. Set `PUBLIC_ORIGIN` to the exact browser-visible origin (scheme, host, optional port; no trailing slash/path). `COOKIE_SECURE=1`, `NODE_ENV=production`, `DATA_DIR=/data` and `PORT=3001` are required. The server **does not trust** `X-Forwarded-For`; socket-IP limits can aggregate all users behind the proxy. Enforce client-aware rate/connection/body limits at the trusted edge. Do not publish port 3001 directly. Use an external TLS/HSTS policy; the Node service itself does not terminate TLS or set HSTS.
4. Probe `GET /api/health` for readiness: 200 `{ "status":"ok" }` only when not draining and SQLite is readable; otherwise 503 `{ "status":"unavailable" }`. This is **not** a disk-write, backup, or deep analyzer check. Restrict health checks to internal monitoring. Set the host termination grace period to **at least 20 seconds**. SIGTERM stops accepting connections, allows up to 12 seconds for active analysis, then aborts remaining workers. A 15-second deadline closes stuck connections; interrupted runs are marked failed or recovered as interrupted on the next start. A hard kill or host power loss cannot be graceful.
5. Verify registration/login, HttpOnly/Secure/SameSite cookie, CSRF rejection, a `debugger;` finding, owned result retrieval, restart persistence, cross-user 404, logout, backup/restore and service restart on the **actual host** before inviting any users. Check that neither `/data` nor backup paths are reachable via HTTP. The static handler serves only `dist/` and does not map arbitrary filesystem paths.

### Backup and restore

Use the built-in SQLite **online backup API** rather than copying a live `devguard.sqlite` file: WAL writes may not yet be in that file. Backups include users, password hashes, sessions, CSRF tokens, projects, paths, findings and evidence; store them encrypted, access-controlled and off-host. Do not place backups in `dist/`, `/data`, logs, or public object storage. A backup destination must **not already exist** and must be outside `DATA_DIR`.

```bash
# While the service is running; run from the deployed app directory with access to the private volume.
npm run db:backup -- /data /PRIVATE/BACKUPS/devguard-YYYYMMDD.sqlite
# Verify backup integrity/schema using the restore tool in a scratch empty directory:
npm run db:restore -- /PRIVATE/BACKUPS/devguard-YYYYMMDD.sqlite /PRIVATE/SCRATCH/empty-data
# Inspect the scratch instance privately, then remove it securely per your retention policy.
```

For a **real restore**, stop the service and confirm it has exited; take a separate copy of the current database and any `-wal`/`-shm` files for rollback. Prepare an **empty** durable `DATA_DIR` owned by UID 1000, then run `npm run db:restore -- /PRIVATE/BACKUPS/devguard-YYYYMMDD.sqlite /data` with write access. Restore refuses to overwrite an existing database or WAL files and checks SQLite integrity and schema version 1. Restart the service and verify health, sign-in, owned runs and fresh analysis. Backups are snapshots: changes since the backup are lost on restore. Establish an operator-owned backup schedule, encryption, restore drills and deletion policy; this application does not schedule or upload backups automatically.

### Deployment boundaries

The SQLite migration (`migrations/001_initial.sql`) runs transactionally at startup for a new database; schema versions newer than this image abort startup. Migrations and disk failures stop the service rather than serving from an in-memory fallback. The `DATA_DIR` must already exist, be absolute, and resolve outside `dist/` in production; this catches accidental ephemeral missing mounts and symlinks into static assets, but cannot prove the volume is durable. These checks do not prove the host's volume is durable or encrypted. Worker V8 heap cap is not a total process/CPU limit; use host/container limits and network restrictions. No cloud deployment, volume mounting, Docker build or TLS proxy was performed by the local tests.
