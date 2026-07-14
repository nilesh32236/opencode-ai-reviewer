import * as fs from 'fs';
import * as path from 'path';
import type {
  Finding,
  FindingType,
  IssueFinding,
  ReviewResult,
  Severity,
  StrengthFinding,
  SummaryFinding,
  VerdictFinding,
} from './types/index.js';

const VALID_TYPES: FindingType[] = ['summary', 'verdict', 'strength', 'issue'];
const VALID_SEVERITIES: Severity[] = ['critical', 'important', 'minor'];

export function parseJsonlFile(filePath: string): ReviewResult {
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    return emptyResult();
  }

  const content = fs.readFileSync(absolutePath, 'utf-8');
  return parseJsonlString(content);
}

export function parseJsonlString(content: string): ReviewResult {
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  const rawLines: string[] = [];
  let failedLines = 0;

  let summary: SummaryFinding | null = null;
  let verdict: VerdictFinding | null = null;
  const strengths: StrengthFinding[] = [];
  const issues: IssueFinding[] = [];

  for (const line of lines) {
    rawLines.push(line);

    try {
      const parsed = JSON.parse(line);
      const finding = validateAndNormalize(parsed);

      switch (finding.type) {
        case 'summary':
          summary = finding as SummaryFinding;
          break;
        case 'verdict':
          verdict = finding as VerdictFinding;
          break;
        case 'strength':
          strengths.push(finding as StrengthFinding);
          break;
        case 'issue':
          issues.push(finding as IssueFinding);
          break;
      }
    } catch {
      failedLines++;
    }
  }

  const criticalCount = issues.filter((i) => i.severity === 'critical').length;
  const importantCount = issues.filter((i) => i.severity === 'important').length;
  const minorCount = issues.filter((i) => i.severity === 'minor').length;

  return {
    summary: summary?.text || '',
    verdict: {
      ready: verdict?.ready ?? false,
      reasoning: verdict?.reasoning || '',
    },
    strengths: strengths.map((s) => ({
      type: 'strength' as const,
      file: s.file || '',
      line: s.line || 0,
      message: s.message,
    })),
    issues: issues.map((i) => ({
      type: 'issue' as const,
      severity: i.severity,
      file: i.file,
      line: i.line,
      message: i.message,
      suggestion: i.suggestion,
      inline: i.inline,
    })),
    stats: {
      total: issues.length,
      critical: criticalCount,
      important: importantCount,
      minor: minorCount,
    },
    rawLines,
    failedLines,
  };
}

function validateAndNormalize(obj: Record<string, unknown>): Finding {
  if (!obj.type || !VALID_TYPES.includes(obj.type as FindingType)) {
    throw new Error(`Invalid or missing "type" field: ${obj.type}`);
  }

  switch (obj.type) {
    case 'summary':
      if (typeof obj.text !== 'string' || obj.text.trim().length === 0) {
        throw new Error('Summary finding must have a non-empty "text" field');
      }
      return { type: 'summary', text: obj.text.trim() } as SummaryFinding;

    case 'verdict':
      if (typeof obj.ready !== 'boolean') {
        throw new Error('Verdict finding must have a boolean "ready" field');
      }
      return {
        type: 'verdict',
        ready: obj.ready,
        reasoning: typeof obj.reasoning === 'string' ? obj.reasoning.trim() : '',
      } as VerdictFinding;

    case 'strength':
      return {
        type: 'strength',
        file: typeof obj.file === 'string' ? obj.file : undefined,
        line: typeof obj.line === 'number' ? obj.line : undefined,
        message: typeof obj.message === 'string' ? obj.message : '',
      } as StrengthFinding;

    case 'issue': {
      if (!VALID_SEVERITIES.includes(obj.severity as Severity)) {
        throw new Error(
          `Invalid severity: ${obj.severity}. Must be one of: ${VALID_SEVERITIES.join(', ')}`,
        );
      }
      if (typeof obj.file !== 'string' || obj.file.trim().length === 0) {
        throw new Error('Issue finding must have a non-empty "file" field');
      }
      if (typeof obj.line !== 'number' || obj.line < 1) {
        throw new Error('Issue finding must have a positive "line" number');
      }
      return {
        type: 'issue',
        severity: obj.severity as Severity,
        file: obj.file.trim(),
        line: obj.line,
        message: typeof obj.message === 'string' ? obj.message : '',
        suggestion: typeof obj.suggestion === 'string' ? obj.suggestion : undefined,
        inline: typeof obj.inline === 'boolean' ? obj.inline : false,
      } as IssueFinding;
    }

    default:
      throw new Error(`Unhandled finding type: ${obj.type}`);
  }
}

function emptyResult(): ReviewResult {
  return {
    summary: '',
    verdict: { ready: false, reasoning: '' },
    strengths: [],
    issues: [],
    stats: { total: 0, critical: 0, important: 0, minor: 0 },
    rawLines: [],
    failedLines: 0,
  };
}

export function buildReviewBody(result: ReviewResult): string {
  const parts: string[] = [];

  parts.push('## AI Code Review Summary');
  parts.push('');
  parts.push(result.summary || 'No summary provided.');
  parts.push('');
  parts.push(`**Ready to merge?** ${result.verdict.ready ? 'Yes' : 'No'}`);
  parts.push('');
  parts.push(`**Reasoning:** ${result.verdict.reasoning || 'No reasoning provided.'}`);
  parts.push('');

  if (result.strengths.length > 0) {
    parts.push('### Strengths');
    parts.push('');
    for (const s of result.strengths) {
      const location = s.file && s.line ? `**${s.file}:${s.line}**` : '';
      parts.push(`- ${location ? location + ' — ' : ''}${s.message}`);
    }
    parts.push('');
  }

  if (result.issues.length > 0) {
    parts.push('### Issues');
    parts.push('');
    for (const i of result.issues) {
      const severityLabel = i.severity.toUpperCase();
      parts.push(`- **${severityLabel}:** ${i.file}:${i.line} — ${i.message}`);
      if (i.suggestion) {
        parts.push(`  > Suggestion: ${i.suggestion}`);
      }
    }
    parts.push('');
  }

  return parts.join('\n');
}

export function buildInlineComments(
  result: ReviewResult,
  diffLines?: Set<string>,
): Array<{ path: string; line: number; side: string; body: string }> {
  return result.issues
    .filter((issue) => {
      if (issue.inline !== true || !issue.line || issue.line < 1) return false;
      if (diffLines && diffLines.size > 0) {
        const key = `${issue.file}:${issue.line}`;
        return diffLines.has(key);
      }
      return true;
    })
    .map((issue) => ({
      path: issue.file.replace(/^\//, ''),
      line: issue.line,
      side: 'RIGHT' as const,
      body: `**${issue.severity.toUpperCase()}**: ${issue.message}${issue.suggestion ? `\n\n> ${issue.suggestion}` : ''}`,
    }));
}
