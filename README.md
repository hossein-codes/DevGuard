# DevGuard

Phase 1 frontend preview for an AI-assisted software quality platform. This workspace is a **demonstration only**: projects, counts, activity, findings, code snippets, and timestamps are illustrative fixtures. No repository is connected, no code is scanned, and no finding is verified or fixed.

## Run locally

```bash
npm install
npm run dev
```

Open the URL printed by Vite. Other commands: `npm run lint`, `npm run typecheck`, `npm run build`.

## Structure

- `src/data.ts` — typed, isolated presentation fixtures; replace with API-backed data in a future phase.
- `src/main.tsx` — app shell, routes, shared list components, and page interactions.
- `src/style.css` — dark visual system and responsive layout.

Available routes: overview `/`, projects `/projects`, project details `/projects/:id`, finding details `/findings/:id`, category views `/security`, `/quality`, `/performance`, `/experience`, and `/settings`. Search and filters operate on local fixtures. Connection, upload, adding projects, AI remediation, and notifications are intentionally disabled until real services exist.
