import { randomBytes, timingSafeEqual } from 'node:crypto'
import { hash, verify } from '@node-rs/argon2'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { type Store, type User } from './storage'

export const sessionAgeMs = 7 * 24 * 60 * 60 * 1000
export const cookieName = process.env.COOKIE_SECURE === '1' ? '__Host-devguard' : 'devguard_session'
export function newSecret() { return randomBytes(32).toString('base64url') }
export function setCookie(res: ServerResponse, token: string, clear = false) {
  res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${clear ? 0 : sessionAgeMs / 1000}${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`)
}
export function cookie(req: IncomingMessage) {
  const raw = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
  return raw && /^[a-zA-Z0-9_-]{43}$/.test(raw) ? raw : undefined
}
export function session(req: IncomingMessage, store: Store): (User & { csrfToken: string; token: string }) | undefined {
  const token = cookie(req)
  const user = token ? store.getSession(token) : undefined
  return user && token ? { ...user, token } : undefined
}
export function originValid(req: IncomingMessage) {
  const expected = process.env.PUBLIC_ORIGIN || `http://${req.headers.host}`
  // Origin must be present even for curl/API clients; avoid trusting forwarded host/proto.
  return Boolean(req.headers.origin && req.headers.origin === expected)
}
export function csrfValid(value: string | undefined, expected: string) {
  if (!value || !/^[a-zA-Z0-9_-]{43}$/.test(value)) return false
  return timingSafeEqual(Buffer.from(value), Buffer.from(expected))
}
export async function passwordHash(password: string) { return hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 }) }
export async function passwordVerify(hashValue: string, password: string) { return verify(hashValue, password) }
