import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import Busboy from 'busboy'
import type { AnalysisRun, SourceFile } from '../shared/analysis'
import { decodeFile, InputError, limits, safePath } from './limits'
import { runWorker } from './runner'
import { createProtection } from './protection'
import { version as eslintVersion } from 'eslint/package.json'
const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const securityHeaders = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" } as const
const runs = new Map<string, AnalysisRun>()
const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders }); res.end(JSON.stringify(value)) }
const fail = (res: ServerResponse, error: InputError) => json(res, error.status, { error: { code: error.code, message: error.message } })
export function parseUpload(req: IncomingMessage): Promise<SourceFile[]> {
  return new Promise((resolve, reject) => {
    if (!req.headers['content-type']?.startsWith('multipart/form-data')) return reject(new InputError('invalid_content_type', 'Use multipart/form-data.'))
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limits.requestBytes) return reject(new InputError('request_too_large', 'Request exceeds the size limit.', 413))
    let parser: ReturnType<typeof Busboy>
    try { parser = Busboy({ headers: req.headers, preservePath: true, limits: { files: limits.files, fileSize: limits.fileBytes, fields: 0, parts: limits.files, fieldSize: 0 } }) } catch { return reject(new InputError('invalid_multipart', 'Invalid multipart request.')) }
    let settled = false, bytes = 0, total = 0
    const files: SourceFile[] = [], paths = new Set<string>(), pending: Promise<void>[] = []
    const rejectOnce = (error: InputError) => { if (!settled) { settled = true; reject(error) } }
    req.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > limits.requestBytes) { rejectOnce(new InputError('request_too_large', 'Request exceeds the size limit.', 413)); req.unpipe(parser); req.resume() } })
    req.on('aborted', () => rejectOnce(new InputError('aborted', 'Upload interrupted.')))
    req.on('error', () => rejectOnce(new InputError('invalid_upload', 'Upload interrupted.')))
    parser.on('filesLimit', () => rejectOnce(new InputError('too_many_files', 'At most 10 files are supported.', 413)))
    parser.on('fieldsLimit', () => rejectOnce(new InputError('unexpected_field', 'Only file parts are supported.')))
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
    parser.on('close', async () => { await Promise.all(pending); if (!settled) { settled = true; if (!files.length) reject(new InputError('no_files', 'Select at least one source file.')); else resolve(files) } })
    req.pipe(parser)
  })
}
export function createApp(analyzer: typeof runWorker = runWorker) {
  const guard = createProtection()
  const server = createServer(async (req, res) => {
  try {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  if (pathname === '/api/health' && req.method === 'GET') return json(res, 200, { status: 'ok' })
  if (pathname.startsWith('/api/runs/') && req.method === 'GET') {
    const limit = guard.rate(req, 'read')
    if (!limit.allowed) { res.setHeader('Retry-After', limit.retryAfter); return json(res, 429, { error: { code: 'rate_limited', message: 'Too many result requests. Try again later.' } }) }
    const id = pathname.slice('/api/runs/'.length)
    if (!runIdPattern.test(id)) return json(res, 400, { error: { code: 'invalid_run_id', message: 'Invalid run ID.' } })
    const run = runs.get(id)
    return run ? json(res, 200, { run }) : json(res, 404, { error: { code: 'not_found', message: 'Run not found.' } })
  }
  if (pathname === '/api/analyze' && req.method === 'POST') {
    const limit = guard.rate(req, 'upload')
    if (!limit.allowed) { res.setHeader('Retry-After', limit.retryAfter); return json(res, 429, { error: { code: 'rate_limited', message: 'Too many analysis requests. Try again later.' } }) }
    // Reserve before parsing: competing uploads cannot build up in memory waiting for a worker.
    const release = guard.acquire()
    if (!release) { res.setHeader('Retry-After', '1'); return json(res, 503, { error: { code: 'busy', message: 'Analyzer is busy. Try again later.' } }) }
    const abort = new AbortController()
    const onDisconnect = () => { if (!res.writableEnded) abort.abort() }
    res.on('close', onDisconnect)
    req.on('aborted', onDisconnect)
    try {
      let files: SourceFile[]
      try { files = await parseUpload(req) } catch (e) { if (!abort.signal.aborted) fail(res, e instanceof InputError ? e : new InputError('invalid_upload', 'Could not read upload.')); return }
      if (abort.signal.aborted) return
      const run: AnalysisRun = { id: randomUUID(), status: 'running', createdAt: new Date().toISOString(), tool: { name: 'ESLint', version: eslintVersion, ruleset: 'devguard-mvp-1' }, fileCount: files.length, findings: [], errors: [] }
      runs.set(run.id, run); if (runs.size > 20) runs.delete(runs.keys().next().value!)
      try { const result = await analyzer(files, limits.durationMs, undefined, abort.signal); run.findings = result.findings; run.errors = result.errors; run.status = result.errors.length ? 'completed_with_errors' : 'completed' }
      catch (e) { run.status = 'failed'; run.errors = [{ code: e instanceof Error && e.message === 'timeout' ? 'analysis_timeout' : 'analysis_failed', message: e instanceof Error && e.message === 'timeout' ? 'Analysis exceeded the time limit.' : 'Analysis could not complete.' }] }
      run.completedAt = new Date().toISOString()
      if (!abort.signal.aborted) json(res, 200, { run })
    } finally { release(); res.off('close', onDisconnect); req.off('aborted', onDisconnect) }
    return
  }
  if (pathname.startsWith('/api/')) return json(res, 404, { error: { code: 'not_found', message: 'Endpoint not found.' } })
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } })
  try {
    const asset = pathname.startsWith('/assets/') && /^[a-zA-Z0-9_.-]+$/.test(pathname.slice(8)) ? join('dist', pathname) : join('dist', 'index.html')
    const data = await readFile(asset)
    const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }
    res.writeHead(200, { 'Content-Type': mime[extname(asset)] ?? 'application/octet-stream', ...securityHeaders }); res.end(req.method === 'HEAD' ? undefined : data)
  } catch { json(res, 404, { error: { code: 'not_found', message: 'Resource not found.' } }) }
  } catch { if (!res.headersSent && !res.destroyed) json(res, 500, { error: { code: 'internal_error', message: 'Request could not be completed.' } }) }
  }); server.requestTimeout = 15_000; return server }