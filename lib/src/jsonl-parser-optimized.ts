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

/** Maximum number of raw lines to keep in memory */
const MAX_RAW_LINES = 10000;

/** Maximum file size to parse (10MB) */
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

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
 * String builder for efficient string concatenation.
 * Avoids the overhead of repeated string concatenation and array joins.
 */
class StringBuilder {
  private parts: string[] = [];
  private length = 0;

  append(str: string): void {
    this.parts.push(str);
    this.length += str.length;
  }

  toString(): string {
    return this.parts.join('');
  }

  getLength(): number {
    return this.length;
  }

  isEmpty(): boolean {
    return this.length === 0;
  }
}

/**
 * Circular buffer for storing raw lines with a maximum size.
 * When the buffer is full, oldest lines are automatically evicted.
 */
class CircularLineBuffer {
  private buffer: string[] = [];
  private maxSize: number;
  private start = 0;
  private count = 0;

  constructor(maxSize: number = MAX_RAW_LINES) {
    this.maxSize = maxSize;
    this.buffer = new Array(maxSize);
  }

  add(line: string): void {
    if (this.count < this.maxSize) {
      this.buffer[this.count] = line;
      this.count++;
    } else {
      // Overwrite oldest
      this.buffer[this.start] = line;
      this.start = (this.start + 1) % this.maxSize;
    }
  }

  toArray(): string[] {
    if (this.count < this.maxSize) {
      return this.buffer.slice(0, this.count);
    }
    
    // Return all elements in order
    const result: string[] = [];
    for (let i = 0; i < this.maxSize; i++) {
      const idx = (this.start + i) % this.maxSize;
      result.push(this.buffer[idx]);
    }
    return result;
  }

  get length(): number {
    return this.count;
  }

  clear(): void {
    this.buffer = new Array(this.maxSize);
    this.start = 0;
    this.count = 0;
  }
}

/**
 * Incremental JSONL parser state with memory-efficient storage.
 * Uses circular buffer for raw lines to limit memory usage.
 */
class JsonlParserState {
  private readonly rawLines: CircularLineBuffer;
  private failedLines = 0;
  private truncated = false;

  private summary: SummaryFinding | null = null;
  private verdict: VerdictFinding | null = null;
  private readonly strengths: StrengthFinding[] = [];
  private readonly issues: IssueFinding[] = [];

  private executiveSummary:
    | {
        purpose: string;
        riskLevel: 'low' | 'medium' | 'high';
        riskRationale: string;
        breakingChanges: string[];
      }
    | undefined;

  constructor(maxLines: number = MAX_RAW_LINES) {
    this.rawLines = new CircularLineBuffer(maxLines);
  }

  /**
   * Feed a single raw JSONL line into the parser state.
   * @param line - Raw line (may include surrounding whitespace or a BOM prefix).
   */
  addLine(line: string): void {
    // Trim before parse so BOM/whitespace-prefixed lines behave identically
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('```')) return;

    // Store in circular buffer
    this.rawLines.add(trimmed);

    try {
      const parsed = JSON.parse(trimmed);

      // Handle executive_summary separately since it's not a standard FindingType
      if (parsed.type === 'executive_summary') {
        this.executiveSummary = {
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
        return;
      }

      const finding = validateAndNormalize(parsed);

      switch (finding.type) {
        case 'summary':
          this.summary = finding as SummaryFinding;
          break;
        case 'verdict':
          this.verdict = finding as VerdictFinding;
          break;
        case 'strength':
          this.strengths.push(finding as StrengthFinding);
          break;
        case 'issue':
          this.issues.push(finding as IssueFinding);
          break;
      }
    } catch {
      this.failedLines++;
    }
  }

  /**
   * Materialize the accumulated state into a structured ReviewResult.
   * @returns A ReviewResult with parsed findings.
   */
  finish(): ReviewResult {
    const counts = this.issues.reduce(
      (acc, i) => {
        if (i.severity === 'critical') acc.critical++;
        else if (i.severity === 'important') acc.important++;
        else if (i.severity === 'minor') acc.minor++;
        return acc;
      },
      { critical: 0, important: 0, minor: 0 },
    );

    const confidenceCounts = this.issues.reduce(
      (acc, i) => {
        if (i.confidence === 'high') acc.highConfidence++;
        else if (i.confidence === 'medium') acc.mediumConfidence++;
        else if (i.confidence === 'low') acc.lowConfidence++;
        return acc;
      },
      { highConfidence: 0, mediumConfidence: 0, lowConfidence: 0 },
    );

    return {
      summary: this.summary?.text || '',
      verdict: {
        ready: this.verdict?.ready ?? false,
        reasoning: this.verdict?.reasoning || '',
        autoFixable: this.verdict?.autoFixable ?? false,
        confidence: this.verdict?.confidence || 'low',
      },
      strengths: this.strengths.map((s) => ({
        type: 'strength' as const,
        file: s.file || '',
        line: s.line || 0,
        message: s.message,
      })),
      issues: this.issues.map((i) => ({
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
        category: i.category,
      })),
      stats: {
        total: this.issues.length,
        critical: counts.critical,
        important: counts.important,
        minor: counts.minor,
        highConfidence: confidenceCounts.highConfidence || undefined,
        mediumConfidence: confidenceCounts.mediumConfidence || undefined,
        lowConfidence: confidenceCounts.lowConfidence || undefined,
      },
      rawLines: this.rawLines.toArray(),
      failedLines: this.failedLines,
      executiveSummary: this.executiveSummary,
      truncated: this.truncated,
    };
  }

  markTruncated(): void {
    this.truncated = true;
  }
}

/**
 * Parse a JSONL file containing review findings and return a structured ReviewResult.
 * The file is read line-by-line with streaming to minimize memory usage.
 * Returns an empty result if the file does not exist.
 *
 * @param filePath - Path to the JSONL file to parse.
 * @param maxLines - Maximum number of lines to process (default: unlimited).
 * @returns A Promise resolving to a ReviewResult with parsed findings.
 */
export async function parseJsonlFile(
  filePath: string,
  maxLines?: number,
): Promise<ReviewResult> {
  const absolutePath = path.resolve(filePath);

  // Check file size before processing
  try {
    const stats = await fs.promises.stat(absolutePath);
    if (stats.size > MAX_FILE_SIZE_BYTES) {
      // For very large files, use streaming with line limit
      return parseJsonlFileStreaming(absolutePath, maxLines ?? 10000);
    }
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return emptyResult();
    }
    throw err;
  }

  const stream = fs.createReadStream(absolutePath, { encoding: 'utf-8', highWaterMark: 64 * 1024 });

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
    const state = new JsonlParserState(maxLines);
    let lineCount = 0;
    
    for await (const line of rl) {
      if (maxLines && lineCount >= maxLines) {
        state.markTruncated();
        break;
      }
      state.addLine(line);
      lineCount++;
      
      // Periodically yield to event loop for large files
      if (lineCount % 1000 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    return state.finish();
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
 * Parse a very large JSONL file with streaming and line limiting.
 */
async function parseJsonlFileStreaming(
  filePath: string,
  maxLines: number,
): Promise<ReviewResult> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 64 * 1024 });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  try {
    const state = new JsonlParserState(maxLines);
    let lineCount = 0;
    
    for await (const line of rl) {
      if (lineCount >= maxLines) {
        state.markTruncated();
        break;
      }
      state.addLine(line);
      lineCount++;
      
      if (lineCount % 1000 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    
    return state.finish();
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * Parse a JSONL string containing review findings and return a structured ReviewResult.
 * Uses streaming for large strings to minimize memory usage.
 *
 * @param content - The JSONL string to parse.
 * @param maxLines - Maximum number of lines to process.
 * @returns A ReviewResult with parsed findings.
 */
export function parseJsonlString(
  content: string,
  maxLines?: number,
): ReviewResult {
  const sanitized = stripMarkdownFences(content);
  const state = new JsonlParserState(maxLines);
  
  const lines = sanitized.split('\n');
  const limit = maxLines ?? lines.length;
  
  for (let i = 0; i < Math.min(lines.length, limit); i++) {
    state.addLine(lines[i]);
  }
  
  if (lines.length > limit) {
    state.markTruncated();
  }
  
  return state.finish();
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
        category: typeof obj.category === 'string' ? obj.category : undefined,
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
      const builder = new StringBuilder();
      builder.append(`${getSeverityBadge(issue.severity)} **${issue.severity.toUpperCase()}**: ${issue.message}${formatConfidenceLabel(issue.confidence)}`);
      
      if (issue.suggestion) {
        builder.append(`\n\n> \ud83d\udca1 **How to fix:** ${issue.suggestion}`);
      }
      if (issue.suggestionCode) {
        builder.append(`\n\n\`\`\`suggestion\n${issue.suggestionCode.trim()}\n\`\`\``);
      } else if (issue.suggestion) {
        const suggestion = issue.suggestion.trim();
        if (suggestion.includes('\n')) {
          const lines = suggestion.split('\n').filter((l) => l.trim());
          const hasDiffPrefixes = lines.some((l) => l.startsWith('+') || l.startsWith('-'));
          if (hasDiffPrefixes) {
            const diffSuggestion = lines
              .map((l) => (l.startsWith('+') || l.startsWith('-') ? l : ` ${l}`))
              .join('\n');
            builder.append(`\n\n\`\`\`diff\n${diffSuggestion}\n\`\`\``);
          } else if (looksLikeCode(suggestion)) {
            builder.append(`\n\n\`\`\`suggestion\n${suggestion}\n\`\`\``);
          }
        } else if (looksLikeCode(suggestion)) {
          builder.append(`\n\n\`\`\`suggestion\n${suggestion}\n\`\`\``);
        }
      }
      
      return {
        path: issue.file.replace(/^\//, ''),
        line: issue.line,
        side: 'RIGHT' as const,
        body: builder.toString(),
      };
    });
}

// Declaration keywords that strongly indicate code when combined with other
// code-like patterns. Uses a word boundary (not whitespace) so standalone
// statements such as `return;` match without forcing trailing whitespace.
const STRONG_KEYWORD_PATTERN =
  /^(const|let|var|import|export|return|if|else|for|while|async|await|function|class|interface|type|enum)\b/;

// Weak code indicators that can also appear in natural language.
const WEAK_CODE_PATTERNS = [
  /[{};()=]/, // Syntax characters
  /^\s*\/\//, // Comments
  /\.\w+\(/, // Method calls
  /=>\s*/, // Arrow functions
  /\?\.\w+/, // Optional chaining
  /\?\?\s/, // Nullish coalescing
];

/**
 * Heuristic to determine if a suggestion string looks like code rather than
 * a natural language description. A suggestion is treated as code only when
 * at least two code patterns match. A single match — even a strong
 * declaration keyword — is insufficient: keywords like `if`, `return`,
 * `type`, and `class` are also common English words, and a lone keyword
 * cannot distinguish a real declaration from prose such as
 * "if you have any questions, please ask" or "return the result to the
 * caller." Genuine declarations (`const x = 1;`, `function foo() {}`,
 * `return;`) also match a weak symbol pattern (`=`, `;`, `(`, `{`), so
 * they still classify as code under the >=2 rule.
 * @param suggestion - The suggestion string to evaluate.
 * @returns True if the suggestion contains enough code-like patterns.
 */
function looksLikeCode(suggestion: string): boolean {
  let matchCount = 0;
  if (STRONG_KEYWORD_PATTERN.test(suggestion)) matchCount++;
  for (const pattern of WEAK_CODE_PATTERNS) {
    if (pattern.test(suggestion)) matchCount++;
  }
  return matchCount >= 2;
}
