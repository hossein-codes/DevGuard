import type { IncomingMessage } from 'node:http'

export const protection = Object.freeze({ uploadPerMinute: 5, readsPerMinute: 60, maxWorkers: 2, windowMs: 60_000, maxTrackedClients: 4096 })
type Entry = { count: number; resetAt: number }
export function createProtection(now = Date.now) {
  const buckets = new Map<string, Entry>()
  let active = 0
  function rate(req: IncomingMessage, kind: 'upload' | 'read'): { allowed: boolean; retryAfter: number } {
    // Do not trust X-Forwarded-For from arbitrary clients. A reverse proxy must enforce
    // its own per-client policy; this address may be the proxy for all requests.
    const key = `${kind}:${req.socket.remoteAddress ?? 'unknown'}`
    const time = now()
    const existing = buckets.get(key)
    if (!existing || existing.resetAt <= time) {
      if (!existing && buckets.size >= protection.maxTrackedClients) {
        for (const [id, entry] of buckets) if (entry.resetAt <= time) buckets.delete(id)
        if (buckets.size >= protection.maxTrackedClients) return { allowed: false, retryAfter: 60 }
      }
      buckets.set(key, { count: 1, resetAt: time + protection.windowMs })
      return { allowed: true, retryAfter: 0 }
    }
    if (existing.count >= (kind === 'upload' ? protection.uploadPerMinute : protection.readsPerMinute)) return { allowed: false, retryAfter: Math.max(1, Math.ceil((existing.resetAt - time) / 1000)) }
    existing.count++
    return { allowed: true, retryAfter: 0 }
  }
  function acquire(): (() => void) | null {
    if (active >= protection.maxWorkers) return null
    active++
    let released = false
    return () => { if (!released) { released = true; active-- } }
  }
  return { rate, acquire }
}
