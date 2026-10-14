import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import Busboy from 'busboy'
import type { AnalysisRun, SourceFile } from '../shared/analysis'
import { decodeFile, InputError, limits, safePath } from './limits'
import { runWorker } from './runner'
import { version as eslintVersion } from 'eslint/package.json'
const runs = new Map<string, AnalysisRun>()
const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)) }
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
export function createApp() { const server = createServer(async (req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  if (pathname === '/api/health' && req.method === 'GET') return json(res, 200, { status: 'ok' })
  if (pathname.startsWith('/api/runs/') && req.method === 'GET') { const run = runs.get(pathname.slice('/api/runs/'.length)); return run ? json(res, 200, { run }) : json(res, 404, { error: { code: 'not_found', message: 'Run not found.' } }); server.requestTimeout = 15_000; return server }  if (pathname === '/api/analyze' && req.method === 'POST') {
    let files: SourceFile[]
    try { files = await parseUpload(req) } catch (e) { return fail(res, e instanceof InputError ? e : new InputError('invalid_upload', 'Could not read upload.')) }
    const run: AnalysisRun = { id: randomUUID(), status: 'running', createdAt: new Date().toISOString(), tool: { name: 'ESLint', version: eslintVersion, ruleset: 'devguard-mvp-1' }, fileCount: files.length, findings: [], errors: [] }
    runs.set(run.id, run); if (runs.size > 20) runs.delete(runs.keys().next().value!)
    try { const result = await runWorker(files, limits.durationMs); run.findings = result.findings; run.errors = result.errors; run.status = result.errors.length ? 'completed_with_errors' : 'completed' }
    catch (e) { run.status = 'failed'; run.errors = [{ code: e instanceof Error && e.message === 'timeout' ? 'analysis_timeout' : 'analysis_failed', message: e instanceof Error && e.message === 'timeout' ? 'Analysis exceeded the time limit.' : 'Analysis could not complete.' }] }
    run.completedAt = new Date().toISOString()
    return json(res, 200, { run })
  }
  if (pathname.startsWith('/api/')) return json(res, 404, { error: { code: 'not_found', message: 'Endpoint not found.' } })
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } })
  try {
    const asset = pathname.startsWith('/assets/') && /^[a-zA-Z0-9_.-]+$/.test(pathname.slice(8)) ? join('dist', pathname) : join('dist', 'index.html')
    const data = await readFile(asset)
    const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }
    res.writeHead(200, { 'Content-Type': mime[extname(asset)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' }); res.end(req.method === 'HEAD' ? undefined : data)
  } catch { json(res, 404, { error: { code: 'not_found', message: 'Resource not found.' } }) } }); server.requestTimeout = 15_000; return server }