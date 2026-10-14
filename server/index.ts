import { createApp } from './api'
const port = Number(process.env.PORT ?? 3001)
if (!Number.isInteger(port) || port < 1 || port > 65535 || (process.env.NODE_ENV === 'production' && (!process.env.PUBLIC_ORIGIN?.startsWith('https://') || process.env.COOKIE_SECURE !== '1' || !process.env.DATA_DIR))) {
  console.error('DevGuard configuration invalid: production requires DATA_DIR, HTTPS PUBLIC_ORIGIN and COOKIE_SECURE=1.')
  process.exit(1)
}
try {
  const app = createApp()
  app.on('error', () => { console.error('DevGuard could not bind its listening port.'); process.exit(1) })
  app.listen(port, '0.0.0.0', () => console.log(`DevGuard listening on ${port}`))
} catch {
  console.error('DevGuard could not initialize storage or start.')
  process.exit(1)
}
