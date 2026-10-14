import { resolve, isAbsolute, sep } from 'node:path'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { createApp } from './api'
import { createLifecycle } from './lifecycle'
import { Store } from './storage'
import { createShutdown } from './shutdown'

const port = Number(process.env.PORT ?? 3001)
const dataDir = process.env.DATA_DIR ?? './data'
function validConfig() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false
  if (process.env.NODE_ENV !== 'production') return true
  let origin: URL
  try { origin = new URL(process.env.PUBLIC_ORIGIN ?? '') } catch { return false }
  let data: string, assets: string
  try {
    if (!isAbsolute(dataDir) || !existsSync(dataDir) || !statSync(dataDir).isDirectory()) return false
    data = realpathSync(dataDir)
    assets = existsSync('dist') ? realpathSync('dist') : resolve('dist')
  } catch { return false }
  return origin.protocol === 'https:' && origin.origin === process.env.PUBLIC_ORIGIN && !origin.username && !origin.password && process.env.COOKIE_SECURE === '1' && Boolean(process.env.DATA_DIR) && data !== assets && !data.startsWith(`${assets}${sep}`)
}
if (!validConfig()) {
  console.error('DevGuard configuration invalid: production requires absolute DATA_DIR outside dist, HTTPS PUBLIC_ORIGIN and COOKIE_SECURE=1.')
  process.exit(1)
}
try {
  const store = new Store(dataDir)
  const lifecycle = createLifecycle()
  const app = createApp(undefined, store, lifecycle)
  const shutdown = createShutdown(app, store, lifecycle)
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  app.on('error', () => { console.error('DevGuard could not bind its listening port.'); process.exitCode = 1; void shutdown('server error') })
  app.listen(port, '0.0.0.0', () => console.log(`DevGuard listening on ${port}`))
} catch {
  console.error('DevGuard could not initialize storage or start.')
  process.exit(1)
}
