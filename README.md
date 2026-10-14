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
