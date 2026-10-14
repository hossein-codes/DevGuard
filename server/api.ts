import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from './storage'
import { cookie, csrfValid, newSecret, originValid, passwordHash, passwordVerify, session, setCookie, sessionAgeMs } from './auth'
import Busboy from 'busboy'
import type { AnalysisRun, SourceFile } from '../shared/analysis'
import { decodeFile, InputError, limits, safePath } from './limits'
import { runWorker } from './runner'
import { createProtection } from './protection'
import { createLifecycle, type Lifecycle } from './lifecycle'
import { version as eslintVersion } from 'eslint/package.json'
const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const securityHeaders = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" } as const
const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders }); res.end(JSON.stringify(value)) }
const fail = (res: ServerResponse, error: InputError) => json(res, error.status, { error: { code: error.code, message: error.message } })
export function parseUpload(req: IncomingMessage): Promise<{ files: SourceFile[]; projectId?: string }> {
  return new Promise((resolve, reject) => {
    if (!req.headers['content-type']?.startsWith('multipart/form-data')) return reject(new InputError('invalid_content_type', 'Use multipart/form-data.'))
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limits.requestBytes) return reject(new InputError('request_too_large', 'Request exceeds the size limit.', 413))
    let parser: ReturnType<typeof Busboy>
    try { parser = Busboy({ headers: req.headers, preservePath: true, limits: { files: limits.files, fileSize: limits.fileBytes, fields: 1, parts: limits.files + 1, fieldSize: 64 } }) } catch { return reject(new InputError('invalid_multipart', 'Invalid multipart request.')) }
    let settled = false, bytes = 0, total = 0, projectId: string | undefined
    const files: SourceFile[] = [], paths = new Set<string>(), pending: Promise<void>[] = []
    const rejectOnce = (error: InputError) => { if (!settled) { settled = true; reject(error) } }
    req.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > limits.requestBytes) { rejectOnce(new InputError('request_too_large', 'Request exceeds the size limit.', 413)); req.unpipe(parser); req.resume() } })
    req.on('aborted', () => rejectOnce(new InputError('aborted', 'Upload interrupted.')))
    req.on('error', () => rejectOnce(new InputError('invalid_upload', 'Upload interrupted.')))
    parser.on('filesLimit', () => rejectOnce(new InputError('too_many_files', 'At most 10 files are supported.', 413)))
    parser.on('fieldsLimit', () => rejectOnce(new InputError('unexpected_field', 'Only one projectId field is supported.')))
    parser.on('field', (name, value, info) => { if (name !== 'projectId' || projectId !== undefined || info.valueTruncated) rejectOnce(new InputError('unexpected_field', 'Invalid projectId field.')); else projectId = value })
    parser.on('partsLimit', () => rejectOnce(new InputError('too_many_files', 'At most 10 files are supported.', 413)))
    parser.on('file', (field, stream, info) => {
      if (field !== 'files') { rejectOnce(new InputError('unexpected_field', 'Use the files field.')); stream.resume(); return }
      let path: string
      try { path = safePath(info.filename); if (paths.has(path.toLowerCase())) throw new InputError('duplicate_path', 'Duplicate file paths are not allowed.'); paths.add(path.toLowerCase()) }
      catch (e) { rejectOnce(e as InputError); stream.resume(); return }
      const chunks: Buffer[] = []
      pending.push(new Promise<void>(done => {
        stream.on('data', (chunk: Buffer) => { total += chunk.length; if (total > limits.totalBytes) rejectOnce(new InputError('total_too_large', 'Upload exceeds the total size limit.', 413)); if (total <= limits.totalBytes) chunks.push(chunk) })
        stream.on('limit', () => rejectOnce(new InputError('file_too_large', 'A file exceeds the 256 KiB limit.', 413)))
        stream.on('end', () => { if (!settled) try { files.push(decodeFile(path, Buffer.concat(chunks))) } catch (e) { rejectOnce(e as InputError) }; done() })
      }))
    })
    parser.on('error', () => rejectOnce(new InputError('invalid_multipart', 'Invalid multipart request.')))
    parser.on('close', async () => { await Promise.all(pending); if (!settled) { settled = true; if (!files.length) reject(new InputError('no_files', 'Select at least one source file.')); else resolve({ files, projectId }) } })
    req.pipe(parser)
  })
}
const authError = { error: { code: 'unauthorized', message: 'Sign in required.' } }
const forbidden = { error: { code: 'forbidden', message: 'Invalid request origin or CSRF token.' } }
const dummyHash = '$argon2id$v=19$m=19456,t=2,p=1$zd2uCng37XnQbW6XyIqdXQ$8AFNTsjKHp7h6D/FcXSK1olZQ2WU6QZ4k6Hi09uXKVM'
const bodyLimit = 16 * 1024
async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > bodyLimit) throw new InputError('body_too_large', 'Request body is too large.', 413)
    chunks.push(chunk as Buffer)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new InputError('invalid_json', 'Invalid JSON body.') }
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
export function createApp(analyzer: typeof runWorker = runWorker, store = new Store(process.env.DATA_DIR ?? './data'), lifecycle: Lifecycle = createLifecycle()) {
  const guard = createProtection()
  store.prune()
  store.deleteExpired()
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      if (pathname === '/api/health' && req.method === 'GET') {
        if (lifecycle.draining) return json(res, 503, { status: 'unavailable' })
        try { if (!store.healthy()) return json(res, 503, { status: 'unavailable' }) } catch { return json(res, 503, { status: 'unavailable' }) }
        return json(res, 200, { status: 'ok' })
      }
      if (lifecycle.draining) return json(res, 503, { error: { code: 'shutting_down', message: 'Service is shutting down. Try again later.' } })
      if (pathname.startsWith('/api/')) {
        // Any cookie-authenticated mutation must have a verifiable same-origin request.
        if (!['GET', 'HEAD'].includes(req.method ?? '') && !originValid(req)) return json(res, 403, forbidden)
        if (pathname === '/api/auth/register' || pathname === '/api/auth/login') {
          if (req.method !== 'POST') return json(res, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } })
          const limit = guard.rate(req, 'auth')
          if (!limit.allowed) { res.setHeader('Retry-After', limit.retryAfter); return json(res, 429, { error: { code: 'rate_limited', message: 'Try again later.' } }) }
          if (!req.headers['content-type']?.startsWith('application/json')) throw new InputError('invalid_content_type', 'Use application/json.')
          const body = await readJson(req)
          if (!isRecord(body) || typeof body.email !== 'string' || typeof body.password !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) || body.email.length > 254 || Buffer.byteLength(body.password) < 12 || Buffer.byteLength(body.password) > 128) throw new InputError('invalid_credentials', 'Use a valid email and a password of 12–128 bytes.')
          const email = body.email.trim().toLowerCase()
          let user
          if (pathname.endsWith('/register')) {
            // Hash before insertion; UNIQUE constraint prevents races and duplicate identities.
            const hashed = await passwordHash(body.password)
            try { user = store.createUser(email, hashed) }
            catch (e) { if (isRecord(e) && typeof e.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT')) return json(res, 409, { error: { code: 'registration_unavailable', message: 'Unable to register with these details.' } }); throw e }
          } else {
            const credentials = store.getCredentials(email)
            // Perform a real hash verification for unknown users to reduce timing distinctions.
            const valid = credentials ? await passwordVerify(credentials.passwordHash, body.password) : await passwordVerify(dummyHash, body.password)
            if (!credentials || !valid) return json(res, 401, { error: { code: 'invalid_credentials', message: 'Invalid email or password.' } })
            user = { id: credentials.id, email: credentials.email }
          }
          const old = cookie(req); if (old) store.deleteSession(old)
          const token = newSecret(), csrf = newSecret()
          store.createSession(user.id, token, csrf, Date.now() + sessionAgeMs)
          setCookie(res, token)
          return json(res, 200, { user, csrfToken: csrf })
        }
        const current = session(req, store)
        if (!current) return json(res, 401, authError)
        if (pathname === '/api/session' && req.method === 'GET') return json(res, 200, { user: { id: current.id, email: current.email }, csrfToken: current.csrfToken })
        if (req.method !== 'GET' && req.method !== 'HEAD' && !csrfValid(req.headers['x-csrf-token'] as string | undefined, current.csrfToken)) return json(res, 403, forbidden)
        if (pathname === '/api/auth/logout' && req.method === 'POST') { store.deleteSession(current.token); setCookie(res, '', true); return json(res, 200, { ok: true }) }
        if (pathname === '/api/projects' && req.method === 'GET') return json(res, 200, { projects: store.projects(current.id) })
        if (pathname === '/api/projects' && req.method === 'POST') {
          const body = await readJson(req)
          if (!isRecord(body) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) throw new InputError('invalid_project', 'Provide a project name of 1–80 characters.')
          return json(res, 201, { project: store.createProject(current.id, body.name.trim()) })
        }
        if (pathname.startsWith('/api/projects/') && req.method === 'GET') {
          const id = pathname.slice('/api/projects/'.length)
          if (!runIdPattern.test(id)) throw new InputError('invalid_project_id', 'Invalid project ID.')
          const project = store.project(current.id, id)
          return project ? json(res, 200, { project }) : json(res, 404, { error: { code: 'not_found', message: 'Project not found.' } })
        }
        if (pathname === '/api/runs' && req.method === 'GET') {
          const limit = guard.rate(req, 'read')
          if (!limit.allowed) { res.setHeader('Retry-After', limit.retryAfter); return json(res, 429, { error: { code: 'rate_limited', message: 'Too many result requests. Try again later.' } }) }
          return json(res, 200, { runs: store.runs(current.id) })
        }
        if (pathname.startsWith('/api/runs/') && ['GET', 'DELETE'].includes(req.method ?? '')) {
          const limit = guard.rate(req, 'read')
          if (!limit.allowed) { res.setHeader('Retry-After', limit.retryAfter); return json(res, 429, { error: { code: 'rate_limited', message: 'Too many result requests. Try again later.' } }) }
          const id = pathname.slice('/api/runs/'.length)
          if (!runIdPattern.test(id)) throw new InputError('invalid_run_id', 'Invalid run ID.')
          if (req.method === 'DELETE') return store.deleteRun(current.id, id) ? json(res, 200, { ok: true }) : json(res, 404, { error: { code: 'not_found', message: 'Run not found.' } })
          const run = store.run(current.id, id)
          return run ? json(res, 200, { run }) : json(res, 404, { error: { code: 'not_found', message: 'Run not found.' } })
        }
        if (pathname === '/api/analyze' && req.method === 'POST') {
          const limit = guard.rate(req, 'upload')
          if (!limit.allowed) { res.setHeader('Retry-After', limit.retryAfter); return json(res, 429, { error: { code: 'rate_limited', message: 'Too many analysis requests. Try again later.' } }) }
          const release = guard.acquire()
          if (!release) { res.setHeader('Retry-After', '1'); return json(res, 503, { error: { code: 'busy', message: 'Analyzer is busy. Try again later.' } }) }
          const abort = new AbortController()
          lifecycle.active.add(abort)
          const onDisconnect = () => { if (!res.writableEnded) abort.abort() }
          res.on('close', onDisconnect); req.on('aborted', onDisconnect)
          let savedRun: AnalysisRun | undefined
          try {
            let files: SourceFile[], projectId: string | undefined
            try { ({ files, projectId } = await parseUpload(req)) }
            catch (e) { if (!abort.signal.aborted) fail(res, e instanceof InputError ? e : new InputError('invalid_upload', 'Could not read upload.')); return }
            if (abort.signal.aborted) return
            const project = projectId ? store.project(current.id, projectId) : store.projects(current.id)[0]
            if (!project) return json(res, 404, { error: { code: 'not_found', message: 'Project not found.' } })
            const run: AnalysisRun = { id: randomUUID(), status: 'running', createdAt: new Date().toISOString(), tool: { name: 'ESLint', version: eslintVersion, ruleset: 'devguard-mvp-1' }, fileCount: files.length, findings: [], errors: [] }
            store.prune(); store.deleteExpired()
            store.createRun(current.id, project.id, run); savedRun = run
            try { const result = await analyzer(files, limits.durationMs, undefined, abort.signal); run.findings = result.findings; run.errors = result.errors; run.status = result.errors.length ? 'completed_with_errors' : 'completed' }
            catch (e) { run.status = 'failed'; run.errors = [{ code: e instanceof Error && e.message === 'timeout' ? 'analysis_timeout' : 'analysis_failed', message: e instanceof Error && e.message === 'timeout' ? 'Analysis exceeded the time limit.' : 'Analysis could not complete.' }] }
            run.completedAt = new Date().toISOString()
            store.finishRun(current.id, run); savedRun = undefined
            if (!abort.signal.aborted) json(res, 200, { run })
          } finally {
            if (savedRun) try { store.markInterrupted(current.id, savedRun.id) } catch { /* recovered on next startup */ }
            lifecycle.active.delete(abort); release(); res.off('close', onDisconnect); req.off('aborted', onDisconnect)
          }
          return
        }
        return json(res, 404, { error: { code: 'not_found', message: 'Endpoint not found.' } })
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } })
      try {
        const asset = pathname.startsWith('/assets/') && /^[a-zA-Z0-9_.-]+$/.test(pathname.slice(8)) ? join('dist', pathname) : join('dist', 'index.html')
        const data = await readFile(asset)
        const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }
        res.writeHead(200, { 'Content-Type': mime[extname(asset)] ?? 'application/octet-stream', ...securityHeaders }); res.end(req.method === 'HEAD' ? undefined : data)
      } catch { json(res, 404, { error: { code: 'not_found', message: 'Resource not found.' } }) }
    } catch (e) {
      if (!res.headersSent && !res.destroyed) {
        if (e instanceof InputError) fail(res, e)
        else json(res, 503, { error: { code: 'service_unavailable', message: 'Request could not be completed.' } })
      }
    }
  })
  server.requestTimeout = 15_000
  return server
}
