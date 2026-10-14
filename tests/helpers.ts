import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Store } from '../server/storage'
import { createApp } from '../server/api'
import { runWorker } from '../server/runner'
export type Client = { base: string; cookie: string; csrf: string; user: { id: string; email: string }; origin: string }
export function fixture(analyzer: typeof runWorker = runWorker) {
  const directory = mkdtempSync(join(tmpdir(), 'devguard-test-'))
  const store = new Store(directory)
  const app = createApp(analyzer, store)
  return { app, store, async start() { await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${(app.address() as AddressInfo).port}` }, async close() { await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve())); store.close(); rmSync(directory, { recursive: true, force: true }) } }
}
export async function register(base: string, email = 'user@example.test'): Promise<Client> {
  const response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'strong test password 12345' }) })
  if (!response.ok) throw new Error(`Register failed: ${response.status} ${await response.text()}`)
  const data = await response.json()
  return { base, origin: base, user: data.user, csrf: data.csrfToken, cookie: response.headers.get('set-cookie')!.split(';')[0] }
}
export function upload(client: Client, files: Array<[string, string | Uint8Array]>) {
  const form = new FormData()
  for (const [name, value] of files) form.append('files', new Blob([value as BlobPart]), name)
  return fetch(`${client.base}/api/analyze`, { method: 'POST', headers: { Cookie: client.cookie, Origin: client.origin, 'X-CSRF-Token': client.csrf }, body: form })
}
export function get(client: Client, path: string) { return fetch(`${client.base}${path}`, { headers: { Cookie: client.cookie } }) }
