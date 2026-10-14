export type RunStatus = 'queued' | 'running' | 'completed' | 'completed_with_errors' | 'failed'
export type Provenance = 'tool_detected' | 'ai_suggested'
export type Severity = 'High' | 'Medium' | 'Low'
export type Category = 'Security' | 'Bugs & Quality' | 'Code Quality'
export type AnalysisFinding = {
  id: string; ruleId: string; category: Category; severity: Severity; filePath: string;
  line: number; column: number; message: string; evidence?: string; remediation?: string;
  provenance: Provenance
}
export type AnalysisError = { code: string; message: string; filePath?: string }
export type AnalysisRun = {
  id: string; status: RunStatus; createdAt: string; completedAt?: string;
  tool: { name: 'ESLint'; version: string; ruleset: string };
  fileCount: number; findings: AnalysisFinding[]; errors: AnalysisError[];
}
export type SourceFile = { path: string; content: string }
export const countsFor = (findings: AnalysisFinding[]) => ({
  High: findings.filter(f => f.severity === 'High').length,
  Medium: findings.filter(f => f.severity === 'Medium').length,
  Low: findings.filter(f => f.severity === 'Low').length,
})
