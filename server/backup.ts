import Database from 'better-sqlite3'
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

function checkDatabase(path: string) {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    if (db.pragma('user_version', { simple: true }) !== 1 || db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Database integrity or schema check failed')
  } finally { db.close() }
}
// SQLite online backup API takes a consistent snapshot of the WAL-backed database.
export async function backup(sourceDir: string, destination: string) {
  const source = resolve(sourceDir, 'devguard.sqlite'), target = resolve(destination)
  if (!existsSync(source) || target === source || dirname(target) === resolve(sourceDir)) throw new Error('Invalid backup location')
  if (existsSync(target)) throw new Error('Backup destination already exists')
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.partial-${process.pid}`
  const db = new Database(source, { readonly: true, fileMustExist: true })
  try {
    await db.backup(temporary)
    checkDatabase(temporary)
    chmodSync(temporary, 0o600)
    renameSync(temporary, target)
  } finally { db.close(); rmSync(temporary, { force: true }) }
}
// Restore is OFFLINE ONLY: the caller must stop the server before invoking it.
export function restore(source: string, destinationDir: string) {
  const input = resolve(source), directory = resolve(destinationDir), output = resolve(directory, 'devguard.sqlite')
  if (!existsSync(input) || !statSync(input).isFile() || input === output || basename(input).startsWith('devguard.sqlite-')) throw new Error('Invalid backup file')
  if (existsSync(output) || existsSync(`${output}-wal`) || existsSync(`${output}-shm`)) throw new Error('Destination contains database files; restore requires an empty, stopped data directory')
  checkDatabase(input)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${output}.partial-${process.pid}`
  try { copyFileSync(input, temporary); chmodSync(temporary, 0o600); checkDatabase(temporary); renameSync(temporary, output) }
  finally { rmSync(temporary, { force: true }) }
}
if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  const [command, source, target] = process.argv.slice(2)
  if (!source || !target || !['backup', 'restore'].includes(command)) {
    console.error('Usage: npm run db:backup -- DATA_DIR BACKUP_FILE | npm run db:restore -- BACKUP_FILE EMPTY_DATA_DIR')
    process.exitCode = 2
  } else {
    try {
      if (command === 'backup') await backup(source, target)
      else restore(source, target)
      console.log(command === 'backup' ? 'Consistent SQLite backup created.' : 'SQLite backup restored to empty data directory.')
    } catch {
      console.error('Database backup/restore failed. Verify paths, schema, permissions and that restore is offline.')
      process.exitCode = 1
    }
  }
}
