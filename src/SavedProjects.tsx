import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from './auth'

type Project = { id: string; name: string; createdAt: string }
export function SavedProjects() {
  const { user, csrf, loading } = useAuth()
  const [ownerId, setOwnerId] = useState('')
  const [projects, setProjects] = useState<Project[]>([]), [name, setName] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => { if (!user) return; const controller = new AbortController(); fetch('/api/projects', { signal: controller.signal }).then(r => { if (!r.ok) throw new Error(); return r.json() }).then((data: { projects: Project[] }) => { setProjects(data.projects); setOwnerId(user.id) }).catch(e => { if (e.name !== 'AbortError') setError('Could not load saved projects.') }); return () => controller.abort() }, [user])
  async function add(e: FormEvent) { e.preventDefault(); setBusy(true); setError(''); try { const r = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ name }) }); const data = await r.json(); if (!r.ok) throw new Error(data.error?.message ?? 'Could not create project.'); setProjects(prev => [data.project, ...prev]); setName('') } catch (e) { setError(e instanceof Error ? e.message : 'Could not create project.') } finally { setBusy(false) } }
  if (loading) return <p role="status">Checking saved projects…</p>
  if (!user) return <div className="notice"><span><Link className="text-link" to="/sign-in">Sign in</Link> to view saved projects. The projects below are demonstration data.</span></div>
  if (ownerId !== user.id) return error ? <p role="alert" className="form-error">{error}</p> : <p role="status">Loading your projects…</p>
  return <section className="section"><div className="section-heading"><div><h2>Saved projects</h2><p>Private to your account · {projects.length} projects</p></div></div>{projects.length ? <div className="finding-list">{projects.map(p => <div className="finding-row" key={p.id}><div className="finding-body"><strong>{p.name}</strong><div className="finding-meta">Created {new Date(p.createdAt).toLocaleDateString()} · ID {p.id}</div></div><Link className="text-link" to="/analysis">Analyze files</Link></div>)}</div> : <div className="empty"><h3>No saved projects yet</h3><p>Create a project to organize future analysis runs.</p></div>}<form className="filterbar saved-list" onSubmit={add}><label className="search-field"><span className="sr-only">New project name</span><input value={name} maxLength={80} required placeholder="New project name" onChange={e => setName(e.target.value)}/></label><button type="submit" disabled={busy} className="button button-secondary">{busy ? 'Saving…' : 'Create project'}</button></form>{error && <p role="alert" className="form-error">{error}</p>}</section>
}
