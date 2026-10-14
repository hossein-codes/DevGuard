import { TextDecoder } from 'node:util'
import type { SourceFile } from '../shared/analysis'
export const limits = Object.freeze({ files: 10, fileBytes: 256 * 1024, totalBytes: 1024 * 1024, requestBytes: 1200 * 1024, durationMs: 10_000 })
export class InputError extends Error { constructor(public code: string, message: string, public status = 400) { super(message) } }
export function safePath(raw: string): string {
  const name = raw.replaceAll('\\', '/')
  // Control characters are forbidden in logical file paths.
  // eslint-disable-next-line no-control-regex
  if (!name || name.length > 240 || name.startsWith('/') || /^[a-zA-Z]:/.test(name) || /[\u0000-\u001f\u007f]/.test(name) || name.split('/').some(s => !s || s === '.' || s === '..' || s.startsWith('.')) || name.split('/').some(s => s === 'node_modules')) throw new InputError('unsafe_path', 'A file has an unsafe path.')
  if (!/\.(?:js|mjs|cjs|jsx|ts|tsx)$/i.test(name)) throw new InputError('unsupported_file', 'Only JS, MJS, CJS, JSX, TS and TSX files are supported.')
  return name
}
export function decodeFile(path: string, buffer: Buffer): SourceFile {
  if (!buffer.length) throw new InputError('empty_file', 'Empty files are not supported.')
  if (buffer.length > limits.fileBytes) throw new InputError('file_too_large', 'A file exceeds the 256 KiB limit.', 413)
  let content: string
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer) } catch { throw new InputError('invalid_encoding', 'Files must be valid UTF-8 text.') }
  if (content.includes('\0')) throw new InputError('invalid_encoding', 'Binary files are not supported.')
  return { path: safePath(path), content }
}
