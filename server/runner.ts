import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { AnalysisError, AnalysisFinding, SourceFile } from '../shared/analysis'
export type WorkerResult = { findings: AnalysisFinding[]; errors: AnalysisError[] }
export function runWorker(files: SourceFile[], timeoutMs: number, workerPath = fileURLToPath(new URL('./worker.ts', import.meta.url))): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = fork(workerPath, [], { execArgv: ['--import', 'tsx', '--max-old-space-size=128'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    let done = false
    function finish(error?: Error, result?: WorkerResult) {
      if (done) return
      done = true; clearTimeout(timer); child.kill('SIGKILL')
      if (error) reject(error); else resolve(result!)
    }
    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs)
    child.on('message', (msg: unknown) => {
      if (typeof msg === 'object' && msg !== null && 'ok' in msg && msg.ok === true && 'result' in msg) finish(undefined, msg.result as WorkerResult)
      else finish(new Error('analysis_failed'))
    })
    child.on('error', () => finish(new Error('analysis_failed')))
    child.on('exit', () => finish(new Error('analysis_failed')))
    child.send(files, error => { if (error) finish(new Error('analysis_failed')) })
  })
}
