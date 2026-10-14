import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:net'
import { Store } from '../server/storage'
import { createApp } from '../server/api'
import { createLifecycle } from '../server/lifecycle'
import { createShutdown } from '../server/shutdown'
import { backup, restore } from '../server/backup'
import { register, upload } from './helpers'

async function port() { const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve)); const p = (probe.address() as AddressInfo).port; await new Promise<void>(resolve => probe.close(() => resolve())); return p }
async function processExit(child: ReturnType<typeof spawn>) { return new Promise<number | null>(resolve => child.once('exit', code => resolve(code))) }
test('production rejects incomplete configuration without creating a database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dg-config-'))
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env: { ...process.env, NODE_ENV: 'production', PORT: String(await port()), DATA_DIR: dir, PUBLIC_ORIGIN: 'http://unsafe.example', COOKIE_SECURE: '1' }, stdio: 'ignore' })
    assert.equal(await processExit(child), 1)
    assert.equal(existsSync(join(dir, 'devguard.sqlite')), false)
    const missing = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env: { ...process.env, NODE_ENV: 'production', PORT: String(await port()), DATA_DIR: join(dir, 'not-mounted'), PUBLIC_ORIGIN: 'https://app.example', COOKIE_SECURE: '1' }, stdio: 'ignore' })
    assert.equal(await processExit(missing), 1)
    const linked = join(dir, 'static-data'); symlinkSync(join(process.cwd(), 'dist'), linked)
    const staticDir = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env: { ...process.env, NODE_ENV: 'production', PORT: String(await port()), DATA_DIR: linked, PUBLIC_ORIGIN: 'https://app.example', COOKIE_SECURE: '1' }, stdio: 'ignore' })
    assert.equal(await processExit(staticDir), 1)
    assert.equal(existsSync(join(process.cwd(), 'dist', 'devguard.sqlite')), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('readiness detects unavailable database and shutdown drains active analysis', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dg-drain-'))
  let store = new Store(dir)
  const lifecycle = createLifecycle()
  let complete!: (result: { findings: []; errors: [] }) => void
  const app = createApp(() => new Promise(resolve => { complete = resolve }), store, lifecycle)
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`
  try {
    const user = await register(base)
    const pending = upload(user, [['code.js', 'debugger;']])
    for (let i = 0; i < 50 && !complete; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(typeof complete, 'function')
    const shutdown = createShutdown(app, store, lifecycle, 1000, 8000)
    const closed = new Promise<void>(resolve => app.once('close', () => resolve()))
    shutdown('test')
    assert.equal(lifecycle.draining, true)
    complete({ findings: [], errors: [] })
    const run = (await (await pending).json()).run
    assert.equal(run.status, 'completed')
    await closed
    store = new Store(dir)
    assert.equal(store.run(user.user.id, run.id)?.status, 'completed')
    store.close()
    const broken = new Store(dir)
    const healthApp = createApp(undefined, broken)
    await new Promise<void>(resolve => healthApp.listen(0, '127.0.0.1', resolve))
    const healthBase = `http://127.0.0.1:${(healthApp.address() as AddressInfo).port}`
    assert.deepEqual(await (await fetch(`${healthBase}/api/health`)).json(), { status: 'ok' })
    broken.close()
    const health = await fetch(`${healthBase}/api/health`)
    assert.equal(health.status, 503)
    assert.deepEqual(await health.json(), { status: 'unavailable' })
    await new Promise<void>(resolve => healthApp.close(() => resolve()))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('online SQLite backup, offline restore and refusal to overwrite', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dg-backup-'))
  const data = join(root, 'data'), restored = join(root, 'restored'), file = join(root, 'backups', 'snapshot.sqlite')
  try {
    const store = new Store(data)
    const user = store.createUser('backup@example.test', 'test-hash')
    const project = store.projects(user.id)[0]
    const run = { id: '00000000-0000-4000-8000-000000000002', status: 'running' as const, createdAt: new Date().toISOString(), tool: { name: 'ESLint' as const, version: 'test', ruleset: 'test' }, fileCount: 1, errors: [], findings: [] }
    store.createRun(user.id, project.id, run)
    await backup(data, file)
    assert.equal(existsSync(file), true)
    await assert.rejects(backup(data, file), /already exists/)
    store.close()
    restore(file, restored)
    assert.throws(() => restore(file, restored), /contains database files/)
    const recovered = new Store(restored)
    assert.equal(recovered.getCredentials('backup@example.test')?.id, user.id)
    assert.equal(recovered.run(user.id, run.id)?.status, 'failed') // interrupted run recovery
    recovered.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('valid production config starts healthy and handles SIGTERM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dg-valid-'))
  try {
    const p = await port()
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env: { ...process.env, NODE_ENV: 'production', PORT: String(p), DATA_DIR: dir, PUBLIC_ORIGIN: 'https://app.example', COOKIE_SECURE: '1' }, stdio: 'ignore' })
    const exit = processExit(child)
    let healthy = false
    for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${p}/api/health`); if (r.ok) { healthy = true; break } } catch { /* startup */ } await new Promise(resolve => setTimeout(resolve, 50)) }
    assert.equal(healthy, true)
    child.kill('SIGTERM')
    assert.equal(await exit, 0)
    assert.equal(existsSync(join(dir, 'devguard.sqlite')), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
