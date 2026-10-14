import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createApp } from '../server/api'
import { runWorker } from '../server/runner'
import { countsFor } from '../shared/analysis'
import type { AddressInfo } from 'node:net'
const app = createApp()
let base: string
before(async () => { await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(app.address() as AddressInfo).port}` })
after(() => app.close())
function upload(files: Array<[string, string | Uint8Array]>) { const form = new FormData(); for (const [name, value] of files) form.append('files', new Blob([value as BlobPart]), name); return fetch(`${base}/api/analyze`, { method: 'POST', body: form }).then(async r => ({ status: r.status, data: await r.json() })) }
test('health contains no internals', async () => { const r = await fetch(`${base}/api/health`); assert.deepEqual(await r.json(), { status: 'ok' }) })
test('real violation and severity counts', async () => { const { data } = await upload([['sample.js', 'debugger;\neval("1")']]); assert.equal(data.run.status, 'completed'); assert.deepEqual(data.run.findings.map((f: { ruleId: string }) => f.ruleId).sort(), ['no-debugger', 'no-eval']); assert.deepEqual(countsFor(data.run.findings), { High: 1, Medium: 0, Low: 1 }); assert.equal(data.run.findings[0].provenance, 'tool_detected'); assert.equal(data.run.findings[0].column, 1); assert.equal((await (await fetch(`${base}/api/runs/${data.run.id}`)).json()).run.id, data.run.id) })
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
