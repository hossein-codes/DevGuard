import { useEffect, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, FileCode2, Upload } from 'lucide-react'
import { useAuth } from './auth'
import { countsFor, type AnalysisRun } from '../shared/analysis'

const allowed = /\.(js|mjs|cjs|jsx|ts|tsx)$/i
const accepted = '.js,.mjs,.cjs,.jsx,.ts,.tsx'
function RunView({ run }: { run: AnalysisRun }) {
  const counts = countsFor(run.findings)
  return <section className="section" aria-live="polite"><div className="section-heading"><div><h2>Actual analysis result</h2><p>ESLint {run.tool.version} · {run.fileCount} source files · {new Date(run.createdAt).toLocaleString()}</p></div><span className="status">{run.status.replaceAll('_', ' ')}</span></div>
    <div className="project-summary"><div><span>FINDINGS</span><strong>{run.findings.length}</strong></div><div><span>HIGH / MEDIUM / LOW</span><strong>{counts.High} / {counts.Medium} / {counts.Low}</strong></div><div><span>FILES SUBMITTED</span><strong>{run.fileCount}</strong></div></div>
    {run.errors.length > 0 && <div className="notice warning-notice" role="alert"><div><strong>{run.status === 'failed' ? 'Analysis failed' : 'Some files could not be analyzed'}</strong><ul>{run.errors.map((e, i) => <li key={i}>{e.filePath ? `${e.filePath}: ` : ''}{e.message} ({e.code})</li>)}</ul></div></div>}
    {run.status !== 'failed' && (run.findings.length === 0 ? <div className="empty result-empty"><h3>{run.status === 'completed_with_errors' ? 'No findings in analyzed files' : 'No findings from enabled rules'}</h3><p>{run.status === 'completed_with_errors' ? 'Some files could not be analyzed; review the errors above.' : 'This does not prove the code is secure or free of bugs. Only the listed ESLint rules were run.'}</p></div> : <div className="finding-list result-findings">{run.findings.map(f => <Link key={f.id} to={`/analysis/${run.id}/${f.id}`} className="finding-row"><span className={`finding-indicator indicator-${f.severity.toLowerCase()}`}/><div className="finding-body"><div className="finding-title"><strong>{f.message}</strong><span className={`severity severity-${f.severity.toLowerCase()}`}>{f.severity}</span></div><div className="finding-meta">{f.ruleId} · {f.filePath}:{f.line}:{f.column} · {f.category}</div></div><ArrowRight size={17}/></Link>)}</div>)}
  </section>
}
export function AnalysisPage() { const { user, loading } = useAuth(); if (loading) return <p role="status">Checking session…</p>; if (!user) return <div className="empty"><h3>Sign in to analyze files</h3><p>Your results are saved to your account.</p><Link className="button button-primary" to="/sign-in">Sign in</Link></div>; return <AnalysisWorkspace/> }
function AnalysisWorkspace() {
  const { csrf, refresh } = useAuth()
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([])
  const [projectId, setProjectId] = useState('')
  const [history, setHistory] = useState<Array<{ id: string; status: string; createdAt: string; projectName: string; findingsCount: number }>>([])
  const [run, setRun] = useState<AnalysisRun | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [files, setFiles] = useState<File[]>([])
  const [error, setError] = useState('')
  useEffect(() => { const controller = new AbortController(); fetch('/api/projects', { signal: controller.signal }).then(async r => { if (r.ok) { const data = await r.json(); setProjects(data.projects); setProjectId(data.projects[0]?.id ?? '') } }).catch(() => setError('Could not load projects.')); fetch('/api/runs', { signal: controller.signal }).then(async r => { if (!r.ok) { if (r.status === 401) void refresh(); throw new Error('Session expired') };  return r.json() }).then(async (data: { runs: typeof history }) => { setHistory(data.runs); if (data.runs.length) { const response = await fetch(`/api/runs/${data.runs[0].id}`, { signal: controller.signal }); if (response.ok) setRun((await response.json()).run) } }).catch(e => { if (e.name !== 'AbortError') setError('Unable to load saved analysis. Please sign in again.') }).finally(() => setLoading(false)); return () => controller.abort() }, [refresh])

  async function submit(e: FormEvent) {
    e.preventDefault(); setError('')
    if (!files.length) return setError('Select at least one source file.')
    if (files.length > 10 || files.some(f => !allowed.test(f.name) || !f.size || f.size > 256 * 1024) || files.reduce((n, f) => n + f.size, 0) > 1024 * 1024) return setError('Select 1–10 non-empty supported files, each under 256 KiB and together under 1 MiB.')
    setBusy(true)
    try { const body = new FormData(); if (projectId) body.append('projectId', projectId); files.forEach(f => body.append('files', f, f.webkitRelativePath || f.name)); const response = await fetch('/api/analyze', { method: 'POST', headers: { 'X-CSRF-Token': csrf }, body }); const data = await response.json(); if (!response.ok) { if (response.status === 401) void refresh(); throw new Error(data.error?.message ?? 'Upload failed.') } setRun(data.run); setHistory(previous => [{ id: data.run.id, status: data.run.status, createdAt: data.run.createdAt, projectName: projects.find(p => p.id === projectId)?.name ?? 'My uploads', findingsCount: data.run.findings.length }, ...previous]); setFiles([]); const input = document.getElementById('source-files') as HTMLInputElement | null; if (input) input.value = '' }
    catch (e) { setError(e instanceof Error ? e.message : 'Analysis failed.') } finally { setBusy(false) }
  }
  return <><div className="eyebrow">WORKSPACE / REAL ANALYSIS</div><h1 className="analysis-title">Analyze source files</h1><p className="analysis-subtitle">Run a limited set of real static checks. No uploaded code is executed.</p><div className="notice"><FileCode2 size={17}/><span><strong>Saved results.</strong> Runs are stored in your account for up to 30 days. Do not upload secrets or sensitive source. Demo projects elsewhere in the dashboard are separate.</span></div>
    <form className="panel analysis-form" onSubmit={submit}><h2>Upload source files</h2><p>Select JavaScript or TypeScript source. Up to 10 files, 256 KiB each and 1 MiB total.</p><label htmlFor="analysis-project" className="sr-only">Project for analysis</label><select id="analysis-project" value={projectId} onChange={e => setProjectId(e.target.value)}>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select><br/><label htmlFor="source-files" className="file-label"><Upload size={18}/> Choose files</label><input id="source-files" type="file" multiple accept={accepted} onChange={e => { setFiles(Array.from(e.target.files ?? [])); setError('') }}/><div className="selected-files">{files.length ? files.map((f, i) => <span key={`${f.name}-${i}`}>{f.name} ({Math.ceil(f.size / 1024)} KiB)</span>) : 'No files selected'}</div><button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Analyzing…' : 'Analyze files'}</button>{busy && <p role="status">Validating and analyzing files. This can take a few seconds.</p>}{error && <p className="form-error" role="alert">{error}</p>}</form>
    {history.length > 0 && <section className="section"><div className="section-heading"><h2>Saved runs</h2></div><div className="finding-list">{history.map(item => <button type="button" key={item.id} className="finding-row saved-run" onClick={async () => { const response = await fetch(`/api/runs/${item.id}`); if (response.ok) setRun((await response.json()).run); else setError('Could not load this run.') }}><div className="finding-body"><strong>{item.projectName}</strong><div className="finding-meta">{new Date(item.createdAt).toLocaleString()} · {item.status.replaceAll('_', ' ')} · {item.findingsCount} findings</div></div><ArrowRight size={16}/></button>)}</div></section>}
    {loading ? <p role="status" className="analysis-subtitle">Loading latest run…</p> : run ? <RunView run={run}/> : <div className="empty result-empty"><h3>No real analysis yet</h3><p>Select supported source files above to start. The preview projects are demonstration data only.</p></div>}
  </>
}
export function AnalysisFindingPage() { const { user, loading } = useAuth(); if (loading) return <p role="status">Checking session…</p>; if (!user) return <div className="empty"><h3>Sign in to view this finding</h3><Link to="/sign-in" className="button button-primary">Sign in</Link></div>; return <AnalysisFindingContent/> }
function AnalysisFindingContent() {
  const { id, findingId } = useParams()
  const { refresh } = useAuth()
  const [run, setRun] = useState<AnalysisRun | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { fetch(`/api/runs/${encodeURIComponent(id ?? '')}`).then(r => { if (!r.ok) { if (r.status === 401) void refresh(); throw new Error() } return r.json() }).then((data: { run: AnalysisRun }) => setRun(data.run)).catch(() => setError('Run not found or the API is unavailable.')) }, [id, refresh])
  const finding = run?.findings.find(f => f.id === findingId)
  return <><Link to="/analysis" className="back-link"><ArrowLeft size={16}/> Back to analysis</Link>{error ? <div className="notice warning-notice" role="alert">{error}</div> : !run ? <p role="status">Loading finding…</p> : !finding ? <div className="empty"><h3>Finding not found</h3></div> : <><div className="eyebrow">TOOL-DETECTED / {finding.ruleId}</div><h1 className="analysis-title">{finding.message}</h1><div className="notice warning-notice">Tool-detected lint result, not a confirmed vulnerability. Validate in context before taking action.</div><div className="detail-grid"><section className="panel detail-panel"><h2>Location and evidence</h2><div className="file-location"><span>AFFECTED LOCATION</span><code>{finding.filePath}:{finding.line}:{finding.column}</code></div>{finding.evidence && <div className="evidence"><div>REDACTED / BOUNDED SOURCE LINE</div><pre><code>{finding.evidence}</code></pre></div>}</section><aside className="panel detail-panel"><h2>Finding details</h2><p>Rule: {finding.ruleId}<br/>Severity: {finding.severity}<br/>Category: {finding.category}<br/>Provenance: {finding.provenance}</p><div className="panel-rule"/><h2>Suggested remediation</h2><p>{finding.remediation ?? 'Review this rule output and the surrounding code manually.'}</p></aside></div></>}</>
}
