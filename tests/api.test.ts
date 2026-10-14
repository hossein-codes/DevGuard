import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { fixture, register, upload as authorizedUpload, get, type Client } from './helpers'
import { runWorker } from '../server/runner'
import { countsFor } from '../shared/analysis'
let f: ReturnType<typeof fixture>, base: string, client: Client
beforeEach(async () => { f = fixture(); base = await f.start(); client = await register(base) })
afterEach(async () => f.close())
async function upload(files: Array<[string, string | Uint8Array]>) { const r = await authorizedUpload(client, files); return { status: r.status, data: await r.json() } }
test('health contains no internals', async () => { const r = await fetch(`${base}/api/health`); assert.deepEqual(await r.json(), { status: 'ok' }) })
test('real violation and severity counts', async () => { const { data } = await upload([['sample.js', 'debugger;\neval("1")']]); assert.equal(data.run.status, 'completed'); assert.deepEqual(data.run.findings.map((f: { ruleId: string }) => f.ruleId).sort(), ['no-debugger', 'no-eval']); assert.deepEqual(countsFor(data.run.findings), { High: 1, Medium: 0, Low: 1 }); assert.equal(data.run.findings[0].provenance, 'tool_detected'); assert.equal(data.run.findings[0].column, 1); assert.equal((await (await get(client, `/api/runs/${data.run.id}`)).json()).run.id, data.run.id) })
test('clean supported TSX file yields zero findings', async () => { const { data } = await upload([['view.tsx', 'export const View = () => <div>Hello</div>;']]); assert.equal(data.run.status, 'completed'); assert.equal(data.run.findings.length, 0) })
test('unsupported extension', async () => { const r = await upload([['a.txt', 'hello']]); assert.equal(r.status, 400); assert.equal(r.data.error.code, 'unsupported_file') })
test('empty upload and empty file', async () => { assert.equal((await upload([])).data.error.code, 'no_files'); assert.equal((await upload([['a.js', '']])).data.error.code, 'empty_file') })
test('oversized file and request', async () => { assert.equal((await upload([['a.js', 'x'.repeat(256 * 1024 + 1)]])).status, 413); const r = await upload(Array.from({ length: 5 }, (_, i) => [`big${i}.js`, 'x'.repeat(255 * 1024)])); assert.equal(r.status, 413) })
test('too many files', async () => { const r = await upload(Array.from({ length: 11 }, (_, i) => [`f${i}.js`, 'debugger;'])); assert.equal(r.data.error.code, 'too_many_files') })
test('duplicate and traversal paths', async () => { assert.equal((await upload([['a.js', 'a'], ['a.js', 'b']])).data.error.code, 'duplicate_path'); assert.equal((await upload([['../bad.js', 'debugger;']])).data.error.code, 'unsafe_path') })
test('invalid UTF8', async () => { assert.equal((await upload([['bad.js', new Uint8Array([0xff, 0xfe])]])).data.error.code, 'invalid_encoding') })
test('parse errors produce partial status without fabricated findings', async () => { const { data } = await upload([['bad.ts', 'const = ;'], ['good.js', 'debugger;']]); assert.equal(data.run.status, 'completed_with_errors'); assert.equal(data.run.errors[0].code, 'parse_error'); assert.equal(data.run.findings.length, 1) })
test('worker timeout and failure are bounded', async () => { const files = [{ path: 'a.js', content: 'debugger;' }]; await assert.rejects(runWorker(files, 150, fileURLToPath(new URL('./fixtures/hang.ts', import.meta.url))), /timeout/); await assert.rejects(runWorker(files, 5000, fileURLToPath(new URL('./fixtures/crash.ts', import.meta.url))), /analysis_failed/) })
test('submitted code and configuration are not executed', async () => { const { data } = await upload([['eslint.config.js', 'throw new Error("would execute if loaded");'], ['src.js', 'throw new Error("would execute if run");\ndebugger;']]); assert.equal(data.run.status, 'completed'); assert.ok(data.run.findings.some((f: { ruleId: string }) => f.ruleId === 'no-debugger')) })

test('uploaded inline ESLint directives cannot disable server rules', async () => { const { data } = await upload([['bypass.js', '/* eslint no-debugger: off */\ndebugger;']]); assert.ok(data.run.findings.some((f: { ruleId: string }) => f.ruleId === 'no-debugger')) })

test('analysis worker failure returns a safe failed run that can be retrieved', async () => {
  const failingFixture = fixture(async () => { throw new Error('internal secret should not leak') })
  const origin = await failingFixture.start()
  const failureClient = await register(origin, 'failure@example.test')
  try {
    const form = new FormData()
    form.append('files', new Blob(['debugger;']), 'failure.js')
    const response = await fetch(`${origin}/api/analyze`, { method: 'POST', headers: { Cookie: failureClient.cookie, Origin: origin, 'X-CSRF-Token': failureClient.csrf }, body: form })
    assert.equal(response.status, 200)
    const { run } = await response.json()
    assert.equal(run.status, 'failed')
    assert.equal(run.errors[0].code, 'analysis_failed')
    assert.doesNotMatch(JSON.stringify(run), /internal secret/)
    const retrieved = await get(failureClient, `/api/runs/${run.id}`)
    assert.deepEqual((await retrieved.json()).run, run)
  } finally { await failingFixture.close() }
})
