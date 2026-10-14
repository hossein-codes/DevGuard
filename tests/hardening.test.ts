import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createApp } from '../server/api'
import { runWorker, type WorkerResult } from '../server/runner'
import type { SourceFile } from '../shared/analysis'
import { fileURLToPath } from 'node:url'

async function withServer(app: Server, fn: (base: string) => Promise<void>) {
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve))
  try { await fn(`http://127.0.0.1:${(app.address() as AddressInfo).port}`) }
  finally { await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve())) }
}
function upload(base: string, filename = 'example.js') {
  const body = new FormData()
  body.append('files', new Blob(['debugger;']), filename)
  return fetch(`${base}/api/analyze`, { method: 'POST', body })
}
const empty: WorkerResult = { findings: [], errors: [] }
test('per-client upload and result-read limits return 429 and Retry-After', async () => {
  await withServer(createApp(async () => empty), async base => {
    for (let i = 0; i < 5; i++) assert.equal((await upload(base)).status, 200)
    const limited = await upload(base)
    assert.equal(limited.status, 429)
    assert.equal((await limited.json()).error.code, 'rate_limited')
    assert.ok(Number(limited.headers.get('retry-after')) > 0)
    for (let i = 0; i < 60; i++) assert.equal((await fetch(`${base}/api/runs/not-a-uuid`)).status, 400)
    const readLimited = await fetch(`${base}/api/runs/not-a-uuid`)
    assert.equal(readLimited.status, 429)
    assert.equal((await readLimited.json()).error.code, 'rate_limited')
  })
})
test('invalid and missing run IDs are safe; security headers do not allow CORS', async () => {
  await withServer(createApp(), async base => {
    const invalid = await fetch(`${base}/api/runs/..%2Fsecret`)
    assert.equal(invalid.status, 400)
    assert.equal((await invalid.json()).error.code, 'invalid_run_id')
    const missing = await fetch(`${base}/api/runs/00000000-0000-4000-8000-000000000000`)
    assert.equal(missing.status, 404)
    assert.equal(missing.headers.get('access-control-allow-origin'), null)
    assert.equal(missing.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(missing.headers.get('x-frame-options'), 'DENY')
    assert.ok(missing.headers.get('content-security-policy')?.includes("default-src 'self'"))
  })
})
test('two workers maximum; success and failure release slots', async () => {
  const finishers: Array<(value: WorkerResult) => void> = []
  const app = createApp(() => new Promise(resolve => { finishers.push(resolve) }))
  await withServer(app, async base => {
    const first = upload(base), second = upload(base)
    for (let n = 0; n < 50 && finishers.length < 2; n++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(finishers.length, 2)
    const saturated = await upload(base)
    assert.equal(saturated.status, 503)
    assert.equal((await saturated.json()).error.code, 'busy')
    finishers.shift()!(empty)
    assert.equal((await first).status, 200)
    const third = upload(base)
    for (let n = 0; n < 50 && finishers.length < 2; n++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(finishers.length, 2)
    finishers.shift()!(empty); finishers.shift()!(empty)
    assert.equal((await second).status, 200)
    assert.equal((await third).status, 200)
  })
  let calls = 0
  await withServer(createApp(async () => { calls++; if (calls === 1) throw new Error('sensitive internal failure'); return empty }), async base => {
    const failed = await upload(base)
    assert.equal((await failed.json()).run.errors[0].code, 'analysis_failed')
    assert.equal((await upload(base)).status, 200)
  })
})
test('timeout releases a slot and returns generic error', async () => {
  let calls = 0
  await withServer(createApp(async () => { calls++; if (calls === 1) throw new Error('timeout'); return empty }), async base => {
    const first = await upload(base)
    const run = (await first.json()).run
    assert.equal(run.status, 'failed')
    assert.equal(run.errors[0].code, 'analysis_timeout')
    assert.equal((await upload(base)).status, 200)
  })
})
test('malformed multipart returns structured error and frees slot', async () => {
  await withServer(createApp(async () => empty), async base => {
    const malformed = await fetch(`${base}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=broken' }, body: 'invalid multipart body' })
    assert.equal(malformed.status, 400)
    assert.equal((await malformed.json()).error.code, 'invalid_multipart')
    assert.equal((await upload(base)).status, 200)
  })
})
test('worker abort terminates without leaking a promise', async () => {
  const controller = new AbortController()
  const files: SourceFile[] = [{ path: 'example.js', content: 'debugger;' }]
  const pending = runWorker(files, 5000, fileURLToPath(new URL('./fixtures/hang.ts', import.meta.url)), controller.signal)
  controller.abort()
  await assert.rejects(pending, /aborted/)
})
test('client disconnect aborts running work and releases its slot', async () => {
  let started = 0
  let aborted = 0
  const app = createApp((_files, _timeout, _path, signal) => new Promise<WorkerResult>((resolve, reject) => {
    started++
    if (started > 1) return resolve(empty)
    signal?.addEventListener('abort', () => { aborted++; reject(new Error('aborted')) }, { once: true })
  }))
  await withServer(app, async base => {
    const controller = new AbortController()
    const pending = fetch(`${base}/api/analyze`, { method: 'POST', body: (() => { const form = new FormData(); form.append('files', new Blob(['debugger;']), 'one.js'); return form })(), signal: controller.signal })
    for (let n = 0; n < 50 && !started; n++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(started, 1)
    controller.abort()
    await assert.rejects(pending)
    for (let n = 0; n < 50 && !aborted; n++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(aborted, 1)
    assert.equal((await upload(base)).status, 200)
  })
})
