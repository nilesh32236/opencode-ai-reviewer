import * as fs from 'fs';
import * as readline from 'node:readline';
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
import { formatConfidenceLabel, getSeverityBadge } from './utils/review-body.js';

const VALID_TYPES: FindingType[] = ['summary', 'verdict', 'strength', 'issue'];
const VALID_SEVERITIES: Severity[] = ['critical', 'important', 'minor'];

const MARKDOWN_FENCE_START_REGEX = /```[a-zA-Z0-9-]*\n?/g;
const MARKDOWN_FENCE_END_REGEX = /```\s*$/;

/**
 * Strip markdown code fences from a string.
 * @param content - The string to strip fences from.
 * @returns The string with markdown fences removed.
 */
export function stripMarkdownFences(content: string): string {
  return content
    .replace(MARKDOWN_FENCE_START_REGEX, '')
    .replace(MARKDOWN_FENCE_END_REGEX, '')
    .trim();
}

/**
 * Parse a JSONL file containing review findings and return a structured ReviewResult.
 * The file is read line-by-line; invalid or unparseable lines are counted but skipped.
 * Returns an empty result if the file does not exist.
 * @param filePath - Path to the JSONL file to parse.
 * @returns A Promise resolving to a ReviewResult with parsed findings.
 */
export async function parseJsonlFile(filePath: string): Promise<ReviewResult> {
  const absolutePath = path.resolve(filePath);

  const stream = fs.createReadStream(absolutePath, 'utf-8');

  const streamError = new Promise<never>((_, reject) => {
    stream.once('error', (err: NodeJS.ErrnoException) => {
      reject(err);
    });
  });

  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  const parsePromise = (async () => {
    const rawLines: string[] = [];
    let failedLines = 0;

    let summary: SummaryFinding | null = null;
    let verdict: VerdictFinding | null = null;
    const strengths: StrengthFinding[] = [];
    const issues: IssueFinding[] = [];

    let executiveSummary:
      | {
          purpose: string;
          riskLevel: 'low' | 'medium' | 'high';
          riskRationale: string;
          breakingChanges: string[];
        }
      | undefined;

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('```')) continue;

      rawLines.push(trimmed);

      try {
        const parsed = JSON.parse(trimmed);

        if (parsed.type === 'executive_summary') {
          executiveSummary = {
            purpose: typeof parsed.purpose === 'string' ? parsed.purpose : '',
            riskLevel:
              typeof parsed.riskLevel === 'string' &&
              ['low', 'medium', 'high'].includes(parsed.riskLevel)
                ? (parsed.riskLevel as 'low' | 'medium' | 'high')
                : 'low',
            riskRationale: typeof parsed.riskRationale === 'string' ? parsed.riskRationale : '',
            breakingChanges: Array.isArray(parsed.breakingChanges)
              ? parsed.breakingChanges.filter((c: unknown) => typeof c === 'string')
              : [],
          };
          continue;
        }

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

    const counts = issues.reduce(
      (acc, i) => {
        if (i.severity === 'critical') acc.critical++;
        else if (i.severity === 'important') acc.important++;
        else if (i.severity === 'minor') acc.minor++;
        return acc;
      },
      { critical: 0, important: 0, minor: 0 },
    );

    const confidenceCounts = issues.reduce(
      (acc, i) => {
        if (i.confidence === 'high') acc.highConfidence++;
        else if (i.confidence === 'medium') acc.mediumConfidence++;
        else if (i.confidence === 'low') acc.lowConfidence++;
        return acc;
      },
      { highConfidence: 0, mediumConfidence: 0, lowConfidence: 0 },
    );

    return {
      summary: summary?.text || '',
      verdict: {
        ready: verdict?.ready ?? false,
        reasoning: verdict?.reasoning || '',
        autoFixable: verdict?.autoFixable ?? false,
        confidence: verdict?.confidence || 'low',
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
        suggestionCode: i.suggestionCode,
        inline: i.inline,
        previouslyReported: i.previouslyReported,
        theoreticalRisk: i.theoreticalRisk,
        entryPointPath: i.entryPointPath,
        confidence: i.confidence,
      })),
      stats: {
        total: issues.length,
        critical: counts.critical,
        important: counts.important,
        minor: counts.minor,
        highConfidence: confidenceCounts.highConfidence || undefined,
        mediumConfidence: confidenceCounts.mediumConfidence || undefined,
        lowConfidence: confidenceCounts.lowConfidence || undefined,
      },
      rawLines,
      failedLines,
      executiveSummary,
    };
  })();

  try {
    return await Promise.race([streamError, parsePromise]);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return emptyResult();
    }
    throw err;
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * Parse a JSONL string containing review findings and return a structured ReviewResult.
 * @param content - The JSONL string to parse.
 * @returns A ReviewResult with parsed findings.
 */
export function parseJsonlString(content: string): ReviewResult {
  const sanitized = stripMarkdownFences(content);
  const lines = sanitized.split('\n').filter((line) => line.trim().length > 0);
  const rawLines: string[] = [];
  let failedLines = 0;

  let summary: SummaryFinding | null = null;
  let verdict: VerdictFinding | null = null;
  const strengths: StrengthFinding[] = [];
  const issues: IssueFinding[] = [];

  let executiveSummary:
    | {
        purpose: string;
        riskLevel: 'low' | 'medium' | 'high';
        riskRationale: string;
        breakingChanges: string[];
      }
    | undefined;

  for (const line of lines) {
    rawLines.push(line);

    try {
      const parsed = JSON.parse(line);

      // Handle executive_summary separately since it's not a standard FindingType
      if (parsed.type === 'executive_summary') {
        executiveSummary = {
          purpose: typeof parsed.purpose === 'string' ? parsed.purpose : '',
          riskLevel:
            typeof parsed.riskLevel === 'string' &&
            ['low', 'medium', 'high'].includes(parsed.riskLevel)
              ? (parsed.riskLevel as 'low' | 'medium' | 'high')
              : 'low',
          riskRationale: typeof parsed.riskRationale === 'string' ? parsed.riskRationale : '',
          breakingChanges: Array.isArray(parsed.breakingChanges)
            ? parsed.breakingChanges.filter((c: unknown) => typeof c === 'string')
            : [],
        };
        continue;
      }

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

  const counts = issues.reduce(
    (acc, i) => {
      if (i.severity === 'critical') acc.critical++;
      else if (i.severity === 'important') acc.important++;
      else if (i.severity === 'minor') acc.minor++;
      return acc;
    },
    { critical: 0, important: 0, minor: 0 },
  );

  const confidenceCounts = issues.reduce(
    (acc, i) => {
      if (i.confidence === 'high') acc.highConfidence++;
      else if (i.confidence === 'medium') acc.mediumConfidence++;
      else if (i.confidence === 'low') acc.lowConfidence++;
      return acc;
    },
    { highConfidence: 0, mediumConfidence: 0, lowConfidence: 0 },
  );

  return {
    summary: summary?.text || '',
    verdict: {
      ready: verdict?.ready ?? false,
      reasoning: verdict?.reasoning || '',
      autoFixable: verdict?.autoFixable ?? false,
      confidence: verdict?.confidence || 'low',
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
      suggestionCode: i.suggestionCode,
      inline: i.inline,
      previouslyReported: i.previouslyReported,
      theoreticalRisk: i.theoreticalRisk,
      entryPointPath: i.entryPointPath,
      confidence: i.confidence,
    })),
    stats: {
      total: issues.length,
      critical: counts.critical,
      important: counts.important,
      minor: counts.minor,
      highConfidence: confidenceCounts.highConfidence || undefined,
      mediumConfidence: confidenceCounts.mediumConfidence || undefined,
      lowConfidence: confidenceCounts.lowConfidence || undefined,
    },
    rawLines,
    failedLines,
    executiveSummary,
  };
}

/**
 * Return an empty ReviewResult with default values.
 * @returns An empty ReviewResult.
 */
export function emptyResult(): ReviewResult {
  return {
    summary: '',
    verdict: { ready: false, reasoning: '', autoFixable: false, confidence: 'low' },
    strengths: [],
    issues: [],
    stats: { total: 0, critical: 0, important: 0, minor: 0 },
    rawLines: [],
    failedLines: 0,
    failedBatches: 0,
    executiveSummary: {
      purpose: '',
      riskLevel: 'low',
      riskRationale: '',
      breakingChanges: [],
    },
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
        autoFixable: typeof obj.autoFixable === 'boolean' ? obj.autoFixable : false,
        confidence:
          typeof obj.confidence === 'string' && ['high', 'medium', 'low'].includes(obj.confidence)
            ? (obj.confidence as 'high' | 'medium' | 'low')
            : 'low',
      } as VerdictFinding;

    case 'strength': {
      if (typeof obj.message !== 'string' || obj.message.trim().length === 0) {
        throw new Error('Strength finding must have a non-empty "message" field');
      }
      return {
        type: 'strength',
        file: typeof obj.file === 'string' ? obj.file : undefined,
        line: typeof obj.line === 'number' ? obj.line : undefined,
        message: obj.message.trim(),
      } as StrengthFinding;
    }

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
        suggestionCode: typeof obj.suggestionCode === 'string' ? obj.suggestionCode : undefined,
        inline: typeof obj.inline === 'boolean' ? obj.inline : false,
        previouslyReported:
          typeof obj.previouslyReported === 'boolean' ? obj.previouslyReported : undefined,
        theoreticalRisk: typeof obj.theoreticalRisk === 'boolean' ? obj.theoreticalRisk : undefined,
        entryPointPath: typeof obj.entryPointPath === 'string' ? obj.entryPointPath : undefined,
        confidence:
          typeof obj.confidence === 'string' && ['high', 'medium', 'low'].includes(obj.confidence)
            ? (obj.confidence as 'high' | 'medium' | 'low')
            : undefined,
      } as IssueFinding;
    }

    default:
      throw new Error(`Unhandled finding type: ${obj.type}`);
  }
}

/** An inline review comment on a pull request diff. */
export interface InlineComment {
  path: string;
  line: number;
  side: string;
  body: string;
}

/**
 * Build inline review comments from issues in a ReviewResult, filtered to lines present in the diff.
 * @param result - The review result containing issues.
 * @param diffLines - Optional set of "file:line" strings to filter inline comments to diff lines.
 * @param suppressLowConfidence - When true, filters out issues with low confidence.
 * @returns An array of inline comment objects.
 */
export function buildInlineComments(
  result: ReviewResult,
  diffLines?: Set<string>,
  suppressLowConfidence?: boolean,
): InlineComment[] {
  return result.issues
    .filter((issue) => {
      if (issue.inline !== true || !issue.line || issue.line < 1) return false;
      if (suppressLowConfidence && issue.confidence === 'low') return false;
      if (diffLines && diffLines.size > 0) {
        const key = `${issue.file.replace(/^\//, '')}:${issue.line}`;
        return diffLines.has(key);
      }
      return true;
    })
    .map((issue) => {
      let body = `${getSeverityBadge(issue.severity)} **${issue.severity.toUpperCase()}**: ${issue.message}${formatConfidenceLabel(issue.confidence)}`;
      if (issue.suggestion) {
        body += `\n\n> 💡 **How to fix:** ${issue.suggestion}`;
      }
      if (issue.suggestionCode) {
        body += `\n\n\`\`\`suggestion\n${issue.suggestionCode.trim()}\n\`\`\``;
      } else if (issue.suggestion) {
        const suggestion = issue.suggestion.trim();
        if (suggestion.includes('\n')) {
          // Multi-line suggestion: check if it has diff-style +/- prefixes
          const lines = suggestion.split('\n').filter((l) => l.trim());
          const hasDiffPrefixes = lines.some((l) => l.startsWith('+') || l.startsWith('-'));
          if (hasDiffPrefixes) {
            // Render diff-shaped content in a diff fence
            const diffSuggestion = lines
              .map((l) => (l.startsWith('+') || l.startsWith('-') ? l : ` ${l}`))
              .join('\n');
            body += `\n\n\`\`\`diff\n${diffSuggestion}\n\`\`\``;
          } else if (looksLikeCode(suggestion)) {
            // Multi-line code replacement — wrap as suggestion block
            body += `\n\n\`\`\`suggestion\n${suggestion}\n\`\`\``;
          }
        } else if (looksLikeCode(suggestion)) {
          // Single-line code suggestion — use native GitHub suggestion block
          body += `\n\n\`\`\`suggestion\n${suggestion}\n\`\`\``;
        }
      }
      return {
        path: issue.file.replace(/^\//, ''),
        line: issue.line,
        side: 'RIGHT' as const,
        body,
      };
    });
}

// Common code indicators for heuristics
const CODE_PATTERNS = [
  /[{};()=]/, // Syntax characters
  /^(const|let|var|import|export|return|if|else|for|while|async|await|function|class)\s/,
  /^\s*\/\//, // Comments
  /\.\w+\(/, // Method calls
  /=>\s*/, // Arrow functions
  /\?\.\w+/, // Optional chaining
  /\?\?\s/, // Nullish coalescing
];

/**
 * Heuristic to determine if a suggestion string looks like code rather than
 * a natural language description. Checks for common code patterns.
 * @param suggestion - The suggestion string to evaluate.
 * @returns True if the suggestion contains code-like patterns.
 */
function looksLikeCode(suggestion: string): boolean {
  return CODE_PATTERNS.some((p) => p.test(suggestion));
}
