export type Severity = 'Critical' | 'High' | 'Medium' | 'Low'
export type AnalysisStatus = 'Needs review' | 'Completed' | 'In progress'
export type Category = 'Security' | 'Bugs & Quality' | 'Performance' | 'UI/UX'
export type Finding = {
  id: string; projectId: string; title: string; severity: Severity; category: Category;
  summary: string; file?: string; line?: number; evidence?: string;
  impact: string; remediation: string; validation: 'Unverified recommendation' | 'Needs manual validation'
}
export type Project = {
  id: string; name: string; source: string; stack: string[]; analyzedAt: string;
  status: AnalysisStatus; counts: Partial<Record<Severity, number>>; activity: number[]
}

// Presentation-only fixtures. No scan, repository connection, or verification has occurred.
export const projects: Project[] = [
  { id: 'atlas-api', name: 'Atlas API', source: 'github.com/acme/atlas-api', stack: ['Node.js', 'TypeScript', 'PostgreSQL'], analyzedAt: 'Oct 12, 2026 · 10:42 AM', status: 'Needs review', counts: { Critical: 1, High: 3, Medium: 5, Low: 2 }, activity: [4, 5, 3, 7, 6, 9, 11] },
  { id: 'orbit-web', name: 'Orbit Web', source: 'github.com/acme/orbit-web', stack: ['React', 'Next.js'], analyzedAt: 'Oct 11, 2026 · 4:18 PM', status: 'Completed', counts: { High: 1, Medium: 3, Low: 4 }, activity: [2, 4, 3, 6, 5, 7, 8] },
  { id: 'relay-service', name: 'Relay Service', source: 'github.com/acme/relay-service', stack: ['Go', 'Redis'], analyzedAt: 'Oct 09, 2026 · 9:05 AM', status: 'Needs review', counts: { High: 2, Medium: 2, Low: 1 }, activity: [1, 2, 4, 3, 5, 4, 5] },
  { id: 'northstar-app', name: 'Northstar App', source: 'Manual upload · example', stack: ['Vue', 'TypeScript'], analyzedAt: 'Oct 07, 2026 · 2:30 PM', status: 'Completed', counts: { Medium: 2, Low: 3 }, activity: [0, 1, 2, 2, 3, 4, 5] },
]
export const findings: Finding[] = [
  { id: 'f-101', projectId: 'atlas-api', title: 'Potential SQL injection in query construction', severity: 'Critical', category: 'Security', summary: 'User-controlled input appears to be interpolated into a database query.', file: 'src/routes/users.ts', line: 84, evidence: 'const query = `SELECT * FROM users WHERE id = ${userId}`;', impact: 'If input reaches this query unchecked, an attacker may be able to alter its behavior or access unintended data.', remediation: 'Use parameterized queries and validate the expected identifier format at the request boundary.', validation: 'Needs manual validation' },
  { id: 'f-102', projectId: 'atlas-api', title: 'Missing rate limit on authentication route', severity: 'High', category: 'Security', summary: 'The login endpoint does not appear to enforce request throttling.', file: 'src/routes/auth.ts', line: 32, impact: 'Repeated attempts could increase exposure to credential guessing.', remediation: 'Apply a per-account and per-IP rate limit with appropriate monitoring.', validation: 'Unverified recommendation' },
  { id: 'f-103', projectId: 'orbit-web', title: 'Unoptimized image on landing page', severity: 'Medium', category: 'Performance', summary: 'A large hero image may delay the largest contentful paint.', file: 'app/page.tsx', line: 46, evidence: '<img src="/hero.png" alt="Product preview" />', impact: 'Visitors on slower connections may experience a slower first render.', remediation: 'Serve a responsive, compressed image and provide explicit dimensions.', validation: 'Unverified recommendation' },
  { id: 'f-104', projectId: 'relay-service', title: 'Unhandled error in queue consumer', severity: 'High', category: 'Bugs & Quality', summary: 'A rejected job may terminate processing without a retry path.', file: 'internal/queue/consumer.go', line: 118, impact: 'Transient failures could leave messages unprocessed.', remediation: 'Handle the error explicitly and route failed jobs to a retry or dead-letter queue.', validation: 'Needs manual validation' },
  { id: 'f-105', projectId: 'northstar-app', title: 'Form field has no accessible label', severity: 'Medium', category: 'UI/UX', summary: 'The search input may not have an accessible name.', file: 'src/components/Search.vue', line: 21, impact: 'Screen reader users may have difficulty identifying the input.', remediation: 'Associate a visible label or descriptive aria-label with the field.', validation: 'Unverified recommendation' },
  { id: 'f-106', projectId: 'atlas-api', title: 'Verbose error response may expose internals', severity: 'Low', category: 'Security', summary: 'An error handler may return implementation details to clients.', file: 'src/middleware/errors.ts', line: 17, impact: 'Detailed internal errors can help an attacker understand application structure.', remediation: 'Return a generic client message and log details privately.', validation: 'Unverified recommendation' },
]
export const severities: Severity[] = ['Critical', 'High', 'Medium', 'Low']
export const categories: Category[] = ['Security', 'Bugs & Quality', 'Performance', 'UI/UX']
export const findingFor = (id: string) => findings.find(f => f.id === id)
export const projectFor = (id: string) => projects.find(p => p.id === id)
