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
