// Run after npm run build. This exercises npm start as a separate production process.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import assert from 'node:assert/strict'
import { Store } from '../server/storage'

const port = await new Promise<number>((resolve, reject) => {
  const probe = createServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address()
    if (!address || typeof address === 'string') return reject(new Error('No test port'))
    probe.close(() => resolve(address.port))
  })
})
const base = `http://127.0.0.1:${port}`
const directory = mkdtempSync(join(tmpdir(), 'dg-production-'))
const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  cwd: process.cwd(), env: { ...process.env, PORT: String(port), DATA_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
let savedRun: { id: string; owner: string } | undefined
child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString().slice(0, 300) })
child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString().slice(0, 300) })
try {
  let ready = false
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null) throw new Error(`Production server exited: ${output}`)
    try { const response = await fetch(`${base}/api/health`); if (response.ok) { ready = true; break } } catch { /* waiting for process to listen */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(ready, `Production server did not start: ${output}`)
  const page = await fetch(`${base}/analysis`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<div id="root"><\/div>/)
  const registration = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'proof@example.test', password: 'production smoke password 12345' }) })
  assert.equal(registration.status, 200)
  const account = await registration.json()
  const authHeaders = { Origin: base, Cookie: registration.headers.get('set-cookie')!.split(';')[0], 'X-CSRF-Token': account.csrfToken }
  const form = new FormData()
  form.append('files', new Blob(['debugger;\n'], { type: 'text/plain' }), 'example.js')
  const response = await fetch(`${base}/api/analyze`, { method: 'POST', headers: authHeaders, body: form })
  assert.equal(response.status, 200)
  const { run } = await response.json()
  assert.equal(run.status, 'completed')
  assert.ok(run.findings.some((finding: { ruleId: string }) => finding.ruleId === 'no-debugger'))
  assert.equal(run.findings[0].provenance, 'tool_detected')
  const retrieved = await fetch(`${base}/api/runs/${run.id}`, { headers: { Cookie: authHeaders.Cookie } })
  assert.equal(retrieved.status, 200)
  assert.deepEqual((await retrieved.json()).run, run)
  savedRun = { id: run.id, owner: account.user.id }
  const invalid = new FormData()
  invalid.append('files', new Blob(['hello']), 'bad.txt')
  const errorResponse = await fetch(`${base}/api/analyze`, { method: 'POST', headers: authHeaders, body: invalid })
  assert.equal(errorResponse.status, 400)
  assert.equal((await errorResponse.json()).error.code, 'unsupported_file')
  console.log('PASS production server: SPA, real upload/finding, same-run retrieval, structured validation error')
} finally {
  child.kill('SIGTERM')
  const exit = await new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
  assert.equal(exit, 0, `Production server did not shut down cleanly: ${output}`)
  if (savedRun) { const store = new Store(directory); try { assert.equal(store.run(savedRun.owner, savedRun.id)?.status, 'completed') } finally { store.close() } }
  rmSync(directory, { recursive: true, force: true })
}
