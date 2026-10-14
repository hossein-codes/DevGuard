import Database from 'better-sqlite3'
import { mkdirSync, readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import type { AnalysisRun, AnalysisFinding, AnalysisError } from '../shared/analysis'

export const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export type User = { id: string; email: string }
export type ProjectRecord = { id: string; name: string; createdAt: string }
export class Store {
  private db: Database.Database
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, 'devguard.sqlite')
    this.db = new Database(path)
    chmodSync(path, 0o600)
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    const version = this.db.pragma('user_version', { simple: true }) as number
    if (version > 1) throw new Error('Database schema is newer than this application')
    if (version === 0) {
      const sql = readFileSync(fileURLToPath(new URL('../migrations/001_initial.sql', import.meta.url)), 'utf8')
      this.db.transaction(() => { this.db.exec(sql); this.db.pragma('user_version = 1') })()
    }
    this.db.prepare("UPDATE runs SET status = 'failed', completed_at = ?, errors_json = ? WHERE status IN ('running', 'queued')").run(new Date().toISOString(), JSON.stringify([{ code: 'interrupted', message: 'Analysis was interrupted before completion.' }]))
  }
  close() { this.db.close() }
  healthy() { return this.db.prepare('SELECT id FROM users LIMIT 1').all() !== undefined }
  createUser(email: string, hash: string): User {
    const user = { id: randomUUID(), email: email.toLowerCase() }
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run(user.id, user.email, hash, new Date().toISOString())
      this.db.prepare('INSERT INTO projects (id, user_id, name, created_at) VALUES (?, ?, ?, ?)').run(randomUUID(), user.id, 'My uploads', new Date().toISOString())
    })()
    return user
  }
  getCredentials(email: string): (User & { passwordHash: string }) | undefined {
    const row = this.db.prepare('SELECT id, email, password_hash AS passwordHash FROM users WHERE email = ?').get(email.toLowerCase())
    return row as (User & { passwordHash: string }) | undefined
  }
  createSession(userId: string, token: string, csrf: string, expiresAt: number) {
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)').run(digest(token), userId, csrf, expiresAt)
  }
  getSession(token: string): (User & { csrfToken: string }) | undefined {
    const row = this.db.prepare('SELECT users.id, users.email, sessions.csrf_token AS csrfToken FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?').get(digest(token), Date.now())
    return row as (User & { csrfToken: string }) | undefined
  }
  deleteSession(token: string) { this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(token)) }
  deleteExpired() { this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now()) }
  projects(owner: string): ProjectRecord[] { return this.db.prepare('SELECT id, name, created_at AS createdAt FROM projects WHERE user_id = ? ORDER BY created_at DESC').all(owner) as ProjectRecord[] }
  project(owner: string, id: string): ProjectRecord | undefined { return this.db.prepare('SELECT id, name, created_at AS createdAt FROM projects WHERE user_id = ? AND id = ?').get(owner, id) as ProjectRecord | undefined }
  createProject(owner: string, name: string): ProjectRecord { const project = { id: randomUUID(), name, createdAt: new Date().toISOString() }; this.db.prepare('INSERT INTO projects (id, user_id, name, created_at) VALUES (?, ?, ?, ?)').run(project.id, owner, name, project.createdAt); return project }
  createRun(owner: string, projectId: string, run: AnalysisRun) {
    this.db.prepare('INSERT INTO runs (id, project_id, user_id, status, created_at, tool_name, tool_version, ruleset, file_count, errors_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(run.id, projectId, owner, run.status, run.createdAt, run.tool.name, run.tool.version, run.tool.ruleset, run.fileCount, '[]')
  }
  finishRun(owner: string, run: AnalysisRun) {
    this.db.transaction(() => {
      const update = this.db.prepare('UPDATE runs SET status = ?, completed_at = ?, errors_json = ? WHERE id = ? AND user_id = ? AND status = ?').run(run.status, run.completedAt, JSON.stringify(run.errors), run.id, owner, 'running')
      if (!update.changes) throw new Error('Run is not active')
      const insert = this.db.prepare('INSERT INTO findings (id, run_id, rule_id, category, severity, file_path, line, column_number, message, evidence, remediation, provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      for (const f of run.findings) insert.run(f.id, run.id, f.ruleId, f.category, f.severity, f.filePath, f.line, f.column, f.message, f.evidence ?? null, f.remediation ?? null, f.provenance)
    })()
  }
  markInterrupted(owner: string, id: string) {
    this.db.prepare("UPDATE runs SET status = 'failed', completed_at = ?, errors_json = ? WHERE id = ? AND user_id = ? AND status = 'running'").run(new Date().toISOString(), JSON.stringify([{ code: 'interrupted', message: 'Analysis was interrupted before completion.' }]), id, owner)
  }
  run(owner: string, id: string): AnalysisRun | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ? AND user_id = ?').get(id, owner) as Record<string, unknown> | undefined
    if (!row) return undefined
    const findings = this.db.prepare('SELECT id, rule_id AS ruleId, category, severity, file_path AS filePath, line, column_number AS column, message, evidence, remediation, provenance FROM findings WHERE run_id = ?').all(id) as AnalysisFinding[]
    return { id, status: row.status as AnalysisRun['status'], createdAt: row.created_at as string, ...(row.completed_at ? { completedAt: row.completed_at as string } : {}), tool: { name: 'ESLint', version: row.tool_version as string, ruleset: row.ruleset as string }, fileCount: row.file_count as number, errors: JSON.parse(row.errors_json as string) as AnalysisError[], findings: findings.map(f => ({ ...f, ...(f.evidence === null ? { evidence: undefined } : {}), ...(f.remediation === null ? { remediation: undefined } : {}) })) }
  }
  runs(owner: string): Array<{ id: string; status: string; createdAt: string; projectId: string; projectName: string; findingsCount: number }> {
    return this.db.prepare('SELECT runs.id, runs.status, runs.created_at AS createdAt, runs.project_id AS projectId, projects.name AS projectName, (SELECT COUNT(*) FROM findings WHERE run_id = runs.id) AS findingsCount FROM runs JOIN projects ON projects.id = runs.project_id WHERE runs.user_id = ? ORDER BY runs.created_at DESC LIMIT 50').all(owner) as ReturnType<Store['runs']>
  }
  deleteRun(owner: string, id: string) { return this.db.prepare('DELETE FROM runs WHERE id = ? AND user_id = ?').run(id, owner).changes > 0 }
  prune(days = 30) { this.db.prepare('DELETE FROM runs WHERE created_at < ?').run(new Date(Date.now() - days * 86400000).toISOString()) }
}
