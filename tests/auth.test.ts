import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import Database from 'better-sqlite3'
import { Store } from '../server/storage'
import { createApp } from '../server/api'
import { register, upload, get, type Client } from './helpers'

const password = 'strong test password 12345'
async function serve(store: Store) {
  const app = createApp(undefined, store)
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${(app.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve, reject) => app.close(e => e ? reject(e) : resolve())) }
}
function post(client: Client, path: string, body?: unknown, csrf = client.csrf) {
  return fetch(`${client.base}${path}`, { method: 'POST', headers: { Origin: client.base, Cookie: client.cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
}
test('registration, sign-in, session, CSRF, logout, missing/invalid/expired sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dg-auth-')); const store = new Store(dir); const server = await serve(store)
  try {
    const base = server.base
    assert.equal((await fetch(`${base}/api/session`)).status, 401)
    assert.equal((await fetch(`${base}/api/projects`)).status, 401)
    assert.equal((await fetch(`${base}/api/runs/00000000-0000-4000-8000-000000000000`)).status, 401)
    assert.equal((await fetch(`${base}/api/analyze`, { method: 'POST', headers: { Origin: base } })).status, 401)
    const user = await register(base)
    assert.equal((await get(user, '/api/session')).status, 200)
    const invalidCookie = await fetch(`${base}/api/session`, { headers: { Cookie: 'devguard_session=invalid' } })
    assert.equal(invalidCookie.status, 401)
    assert.equal((await post(user, '/api/projects', { name: 'Team app' }, 'wrong')).status, 403)
    assert.equal((await fetch(`${base}/api/projects`, { method: 'POST', headers: { Cookie: user.cookie, 'X-CSRF-Token': user.csrf, Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body: '{"name":"bad"}' })).status, 403)
    assert.equal((await post(user, '/api/projects', { name: 'Team app' })).status, 201)
    const logout = await post(user, '/api/auth/logout')
    assert.equal(logout.status, 200)
    assert.match(logout.headers.get('set-cookie') ?? '', /Max-Age=0/)
    assert.equal((await get(user, '/api/session')).status, 401)
    const wrong = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'user@example.test', password: 'wrong password 12345' }) })
    assert.equal(wrong.status, 401)
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'user@example.test', password }) })
    assert.equal(login.status, 200)
    const loginData = await login.json()
    assert.equal(loginData.user.id, user.user.id)
    const token = login.headers.get('set-cookie')!.split(';')[0]
    assert.match(login.headers.get('set-cookie')!, /HttpOnly; Path=\/; SameSite=Lax/)
    const db = new Database(join(dir, 'devguard.sqlite'))
    db.prepare('UPDATE sessions SET expires_at = 0').run(); db.close()
    assert.equal((await fetch(`${base}/api/session`, { headers: { Cookie: token } })).status, 401)
  } finally { await server.close(); store.close(); rmSync(dir, { recursive: true, force: true }) }
})
test('cross-user project, run and finding isolation; persisted retrieval after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dg-persist-')); let store = new Store(dir); let server = await serve(store)
  try {
    const a = await register(server.base, 'a@example.test'), b = await register(server.base, 'b@example.test')
    const aProject = (await (await get(a, '/api/projects')).json()).projects[0]
    assert.equal((await get(b, `/api/projects/${aProject.id}`)).status, 404)
    const result = await upload(a, [['code.js', 'debugger;']])
    assert.equal(result.status, 200)
    const run = (await result.json()).run
    assert.equal(run.findings[0].ruleId, 'no-debugger')
    assert.equal((await get(b, `/api/runs/${run.id}`)).status, 404)
    assert.equal((await get(b, '/api/runs')).status, 200)
    assert.equal((await get(b, '/api/projects')).status, 200)
    assert.ok(!(await (await get(b, '/api/projects')).json()).projects.some((p: { id: string }) => p.id === aProject.id))
    assert.equal((await (await get(b, '/api/runs')).json()).runs.length, 0)
    assert.equal((await fetch(`${b.base}/api/runs/${run.id}`, { method: 'DELETE', headers: { Cookie: b.cookie, Origin: b.base, 'X-CSRF-Token': b.csrf } })).status, 404)
    const attempted = new FormData(); attempted.append('projectId', aProject.id); attempted.append('files', new Blob(['debugger;']), 'code.js')
    assert.equal((await fetch(`${b.base}/api/analyze`, { method: 'POST', body: attempted, headers: { Cookie: b.cookie, Origin: b.base, 'X-CSRF-Token': b.csrf } })).status, 404)
    await server.close(); store.close()
    store = new Store(dir); server = await serve(store)
    const aAfter = { ...a, base: server.base, origin: server.base }
    assert.deepEqual((await (await get(aAfter, `/api/runs/${run.id}`)).json()).run, run)
    assert.equal((await get({ ...b, base: server.base }, `/api/runs/${run.id}`)).status, 404)
  } finally { await server.close(); store.close(); rmSync(dir, { recursive: true, force: true }) }
})
test('interrupted run recovery and database failure do not expose internals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dg-error-')); let store = new Store(dir); const server = await serve(store)
  try {
    const user = await register(server.base, 'errors@example.test')
    const project = store.projects(user.user.id)[0]
    const run = { id: '00000000-0000-4000-8000-000000000001', status: 'running' as const, createdAt: new Date().toISOString(), tool: { name: 'ESLint' as const, version: 'test', ruleset: 'test' }, fileCount: 1, errors: [], findings: [] }
    store.createRun(user.user.id, project.id, run)
    await server.close(); store.close()
    store = new Store(dir)
    assert.equal(store.run(user.user.id, run.id)?.status, 'failed')
    assert.equal(store.run(user.user.id, run.id)?.errors[0].code, 'interrupted')
    const again = await serve(store)
    store.close()
    const response = await get({ ...user, base: again.base }, '/api/projects')
    assert.equal(response.status, 503)
    assert.doesNotMatch(await response.text(), /sqlite|devguard\.sqlite|password/i)
    await again.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('retention pruning deletes old runs and their findings; password is not stored as plaintext', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dg-retention-')); const store = new Store(dir); const server = await serve(store)
  try {
    const user = await register(server.base, 'retention@example.test')
    const result = await upload(user, [['code.js', 'debugger;']]); const run = (await result.json()).run
    const db = new Database(join(dir, 'devguard.sqlite'))
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.user.id) as { password_hash: string }
    assert.match(row.password_hash, /^\$argon2id\$/)
    assert.notEqual(row.password_hash, password)
    db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', run.id)
    db.close()
    store.prune(30)
    assert.equal((await get(user, `/api/runs/${run.id}`)).status, 404)
  } finally { await server.close(); store.close(); rmSync(dir, { recursive: true, force: true }) }
})
