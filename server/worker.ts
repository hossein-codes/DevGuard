import { ESLint } from 'eslint'
import parser from '@typescript-eslint/parser'
import { randomUUID } from 'node:crypto'
import type { AnalysisError, AnalysisFinding, SourceFile } from '../shared/analysis'

type Output = { findings: AnalysisFinding[]; errors: AnalysisError[] }
const remediation: Record<string, string> = {
  'no-eval': 'Avoid dynamic evaluation. Use explicit parsing and validated dispatch instead.',
  'no-implied-eval': 'Pass a function rather than a string to timer APIs.',
  'no-debugger': 'Remove the debugger statement before shipping.',
  'eqeqeq': 'Use strict equality unless coercion is intentional and reviewed.',
  'no-unused-vars': 'Remove unused bindings or use them intentionally.',
  'no-constant-condition': 'Check whether this condition was meant to vary.',
  'no-unreachable': 'Remove unreachable code or correct the control flow.',
  'no-unsafe-finally': 'Avoid control-flow statements inside finally blocks.',
  'no-undef': 'Declare the identifier or correct its spelling.',
}
export async function analyze(files: SourceFile[]): Promise<Output> {
  // Only this server-owned flat configuration is used. Never discover uploaded configs.
  const eslint = new ESLint({ cwd: process.cwd(), overrideConfigFile: true, allowInlineConfig: false, ignore: false, overrideConfig: [
    { files: ['**/*.{js,mjs,cjs,jsx,ts,tsx}'], languageOptions: { parser, parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' } }, rules: {
      'no-eval': 'error', 'no-implied-eval': 'error', 'no-debugger': 'warn', 'eqeqeq': 'warn',
      'no-constant-condition': 'warn', 'no-unreachable': 'error', 'no-unsafe-finally': 'error', 'no-unused-vars': 'warn',
    } },
    { files: ['**/*.{js,mjs,cjs,jsx}'], rules: { 'no-undef': 'error' } },
    { files: ['**/*.{ts,tsx}'], rules: { 'no-unused-vars': 'off' } },
  ] })
  const findings: AnalysisFinding[] = [], errors: AnalysisError[] = []
  for (const file of files) {
    try {
      const [result] = await eslint.lintText(file.content, { filePath: `${process.cwd()}/${file.path}` })
      for (const msg of result.messages) {
        if (msg.fatal || !msg.ruleId) { errors.push({ code: 'parse_error', message: 'The file could not be parsed.', filePath: file.path }); continue }
        const evidenceLine = file.content.split(/\r?\n/)[(msg.line ?? 1) - 1]?.trim()
        const category = ['no-eval', 'no-implied-eval'].includes(msg.ruleId) ? 'Security' : 'Code Quality'
        findings.push({ id: randomUUID(), ruleId: msg.ruleId, category, severity: msg.ruleId === 'no-eval' || msg.ruleId === 'no-implied-eval' ? 'High' : msg.severity === 2 ? 'Medium' : 'Low', filePath: file.path, line: msg.line ?? 1, column: msg.column ?? 1, message: msg.message.slice(0, 300), ...(msg.ruleId === 'no-debugger' && /^debugger;?$/.test(evidenceLine ?? '') ? { evidence: evidenceLine } : {}), ...(remediation[msg.ruleId] ? { remediation: remediation[msg.ruleId] } : {}), provenance: 'tool_detected' })
      }
    } catch { errors.push({ code: 'analysis_error', message: 'Analysis failed for this file.', filePath: file.path }) }
  }
  return { findings, errors }
}
if (process.send) process.on('message', async (files: SourceFile[]) => {
  try { process.send?.({ ok: true, result: await analyze(files) }) }
  catch { process.send?.({ ok: false }) }
})
