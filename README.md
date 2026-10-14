# DevGuard

DevGuard Phase 2B adds a bounded, real ESLint-based source-file analysis flow. The original dashboard's four projects, charts and finding pages remain **demonstration data**, not real scan results. Use **Analyze files** in the sidebar for actual tool output. Analysis is not a security certification.

## Development

Requires Node.js 22 and npm.

```bash
npm ci
npm run dev:api   # terminal 1: API on port 3001
npm run dev       # terminal 2: Vite on port 5173; proxies /api to 3001
```

Open `http://localhost:5173/analysis`. Select a `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts` or `.tsx` file (for example, a local file containing `debugger;`), then click **Analyze files**. The page shows the actual ESLint result and links to each finding's detail view. A clean file yields a distinct zero-findings result; invalid uploads and partial parse failures show errors. Demo data on the other pages stays separate.

## API

- `GET /api/health` → `{ "status": "ok" }`
- `POST /api/analyze` — `multipart/form-data`, one or more parts named `files`. Returns `{ "run": AnalysisRun }` with ID, status, timestamps, tool metadata, file count, findings and safe errors. Validation errors use `{ "error": { "code", "message" } }` with HTTP 400 or 413.
- `GET /api/runs/:id` → `{ "run": AnalysisRun }` or 404. The browser stores the last run ID locally for refresh. Run IDs are **not** an authorization mechanism.

Example:

```bash
printf 'debugger;\n' > example.js
curl -F 'files=@example.js' http://localhost:3001/api/analyze
```

Limits are defined in `server/limits.ts`: 10 files, 256 KiB per file, 1 MiB aggregate file content, 1.2 MiB entire multipart request and 10 seconds per analysis worker (15-second HTTP request timeout). Paths are normalized and checked; only valid UTF-8 text is accepted. Files are not written to disk. ESLint 9.39.5 uses a fixed server-owned configuration with `@typescript-eslint/parser` 8.71.2. Rules: `no-eval`, `no-implied-eval`, `no-debugger`, `eqeqeq`, `no-constant-condition`, `no-unreachable`, `no-unsafe-finally`, `no-unused-vars` (JS only), and `no-undef` (JS only). This is a deliberately narrow ruleset; it is not a comprehensive vulnerability scanner. TS checks are syntax-aware linting, not type-aware analysis. Severity is a DevGuard mapping of ESLint diagnostics, not proof of exploitability. Only the literal `debugger;` source line is returned as evidence; other source code is not returned or logged. Suggested remediations are static rule guidance, not AI fixes.

## Production and limitations

```bash
npm ci
npm run lint && npm run typecheck && npm test && npm run build
PORT=3001 npm start
```

`npm start` serves both built `dist/` frontend assets and `/api` from one Node process. Set `PORT` as needed and route traffic to that process. The runtime needs its production dependencies (`eslint`, `@typescript-eslint/parser`, `busboy`, `tsx`) and `dist/`. Use a reverse proxy with TLS, request-body limits, connection limits and rate limiting. **Do not expose this unauthenticated MVP to the public or upload confidential code.** Runs are kept in a process-local 20-entry memory cache and disappear on restart; results are visible to anyone possessing a run ID. There is no user isolation, durable storage, GitHub integration, AI, archive upload, or sandbox-grade protection from parser/plugin vulnerabilities. Uploaded code is never executed; the analyzer runs in a capped child process with a deadline and fixed plugins/configuration. Parser and lint rules can still consume resources and may produce false positives or miss real issues. A hardened container, authentication and abuse controls are required before public deployment.

## Phase 2C deployment proof and architecture decision

**Recommended for this proof: one persistent Node.js instance** that serves the built frontend and `/api` on the same origin. It uses the existing `npm start` process and requires no CORS setup or additional infrastructure. `npm run test:production` starts this process on a temporary local port after `npm run build` and checks the SPA route, upload of `debugger;`, the actual ESLint finding, retrieval of the *same* run by ID, and a structured validation error. This is a local production-mode proof, **not a cloud deployment**.

If the frontend must live on Vercel, choose **Vercel static Vite frontend + a separate persistent Node analysis service**, with a same-origin external rewrite for `/api/*`. This adds a second deployment and proxy configuration but leaves the API's child-process and temporary memory behavior on the persistent service. Do not use a browser-side absolute API URL: the UI deliberately uses relative `/api` requests. An example `vercel.json` to create **only after an actual API hostname exists** (replace the illustrative hostname with your own, then test multipart forwarding and route refresh on the deployed URLs):

```json
{
  "rewrites": [
    { "source": "/api/:path*", "destination": "https://YOUR-API-HOST.example/api/:path*" },
    { "source": "/:path*", "destination": "/index.html" }
  ]
}
```

Configure the Vercel project as a Vite static build: install `npm ci`, build `npm run build`, output directory `dist`. Deploy the Node service separately on a provider that allows a long-running Node 22 process and subprocesses: from the repository root run `npm ci`, `npm run build`, then `npm start`; keep one instance running, point HTTPS traffic to `PORT`, and ensure the process starts in the project root with `dist/`, `server/`, `shared/` and runtime `node_modules/` available. For a separate static frontend deploy, build `dist/` on Vercel and set the external rewrite above; do not publish a Vercel rewrite with a placeholder hostname. Verify health, upload, GET-by-ID, a refresh of `/analysis`, and upload-size rejection via the final Vercel URL. A reverse proxy/body limit and upstream request timeout must permit the 1.2 MiB request and analysis duration. Keep `/api` responses uncached (`Cache-Control: no-store` is set by the API). Direct API-origin access is **not** restricted by these rewrites; restrict it at the hosting/network layer before exposure.

Environment variables: `PORT` (optional, defaults to `3001`) is the **only** environment variable this application reads. No credentials, secrets or public `VITE_*` API URL are required for the local proof. In a hosted persistent service, the platform must provide a listening port and start the process in the repo root. Vercel's static site needs an actual API hostname in its deployment-specific rewrite, not an environment variable consumed by application code. Do not paste credentials into `vercel.json`.

Alternative evaluated but **not selected**: Vercel Functions for both frontend and API. Official Vercel docs describe Node.js Function support for Node APIs and list per-function limits (including a 4.5 MB request/response body limit, bundle and execution limits), but the current `server/index.ts` is a long-running listener, not a Vercel handler. Even if child-process spawning works in a particular Function runtime, the worker bundle/entry path and subprocess behavior have **not** been deployed or verified there. More importantly, `GET /api/runs/:id` relies on a process-local map and cannot be relied on across function instances, so this option cannot meet the same-run retrieval requirement without a separate result store. No database is added in this proof.

References checked for the architectural decision: [Vercel Node.js runtime](https://vercel.com/docs/functions/runtimes/node-js), [Function limits](https://vercel.com/docs/functions/limitations), and [external rewrites](https://vercel.com/docs/routing/rewrites). Limits and behavior should be rechecked for the chosen plan at deployment time.

**Not public-ready:** no authentication, ownership, rate limiting, worker concurrency cap, persistent storage, or sandbox-grade containment. An ID is not authorization. In-memory results (at most 20 runs per instance) disappear after restart and are not shared between instances; even a single hosted instance can restart. Keep this proof behind access controls and use non-sensitive sample code only.
