import type { Server } from 'node:http'
import type { Store } from './storage'
import type { Lifecycle } from './lifecycle'

export function createShutdown(app: Server, store: Store, lifecycle: Lifecycle, drainMs = 12_000, forceMs = 15_000) {
  let stopping = false
  return (signal: string) => {
    if (stopping) return
    stopping = true
    lifecycle.draining = true
    console.log(`DevGuard received ${signal}; draining active requests.`)
    const abortTimer = setTimeout(() => {
      if (lifecycle.active.size) console.error('Shutdown deadline reached; interrupting remaining analysis runs.')
      for (const controller of lifecycle.active) controller.abort()
    }, drainMs)
    const forceTimer = setTimeout(() => {
      console.error('Shutdown could not finish; pending runs will be marked interrupted on next startup.')
      app.closeAllConnections()
      process.exitCode = 1
    }, forceMs)
    app.close(error => {
      clearTimeout(abortTimer); clearTimeout(forceTimer)
      try { store.close() } catch { process.exitCode = 1 }
      if (error) process.exitCode = 1
    })
    app.closeIdleConnections()
  }
}
