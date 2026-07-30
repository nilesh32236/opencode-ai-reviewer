import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger.js';

const logger = new Logger('Reachability');

/**
 * Patterns that identify user-input entry points in source code.
 * Grouped by category for reporting.
 */
interface EntryPointPattern {
  category: string;
  label: string;
  regex: RegExp;
}

const ENTRY_POINT_PATTERNS: EntryPointPattern[] = [
  // ── Express / HTTP frameworks ──
  {
    category: 'http',
    label: 'Express route handler',
    regex: /app\.(get|post|put|delete|patch|use|all)\s*\(/i,
  },
  {
    category: 'http',
    label: 'Express Router handler',
    regex: /router\.(get|post|put|delete|patch|use|all)\s*\(/i,
  },
  {
    category: 'http',
    label: 'Koa route handler',
    regex: /router\.(get|post|put|delete|patch)\s*\(/i,
  },
  {
    category: 'http',
    label: 'Fastify route handler',
    regex: /fastify\.(get|post|put|delete|patch)\s*\(/i,
  },
  { category: 'http', label: 'Hapi server route', regex: /server\.route\s*\(/i },
  {
    category: 'http',
    label: 'NestJS controller decorator',
    regex: /@(Get|Post|Put|Delete|Patch|RequestMapping)\s*\(/,
  },
  {
    category: 'http',
    label: 'Next.js API route',
    regex: /export\s+(async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH)\s*\(/,
  },

  // ── CLI entry points ──
  { category: 'cli', label: 'Shebang script', regex: /^#!\/usr\/bin\/env\s+node/ },
  { category: 'cli', label: 'Commander command', regex: /program\.(command|parse)\s*\(/i },
  { category: 'cli', label: 'Yargs command', regex: /yargs\s*\(?\s*\.command\s*\(/i },
  { category: 'cli', label: 'CLI main entry', regex: /process\.argv/ },

  // ── WebSocket / Socket.IO ──
  {
    category: 'websocket',
    label: 'Socket.IO connection',
    regex: /io\.on\s*\(\s*['"]connection['"]\s*,/i,
  },
  {
    category: 'websocket',
    label: 'WebSocket server',
    regex: /ws\.on\s*\(\s*['"]connection['"]\s*,/i,
  },
  {
    category: 'websocket',
    label: 'WebSocket message handler',
    regex: /\.on\s*\(\s*['"]message['"]\s*,/i,
  },

  // ── Message queues ──
  {
    category: 'queue',
    label: 'Kafka consumer',
    regex: /consumer\.(subscribe|run|eachMessage)\s*\(/i,
  },
  { category: 'queue', label: 'RabbitMQ consumer', regex: /channel\.consume\s*\(/i },
  { category: 'queue', label: 'Redis subscriber', regex: /\.subscribe\s*\(/i },

  // ── Serverless / Cloud functions ──
  {
    category: 'serverless',
    label: 'AWS Lambda handler',
    regex: /(exports|module\.exports)\.\s*handler\s*[=(]/,
  },
  { category: 'serverless', label: 'Google Cloud Function', regex: /exports\.\s*\w+\s*=\s*\(/ },
  {
    category: 'serverless',
    label: 'Vercel serverless function',
    regex: /export\s+default\s+(async\s+)?function/,
  },

  // ── Node HTTP server ──
  { category: 'http', label: 'HTTP server create', regex: /https?\.createServer\s*\(/i },
  { category: 'http', label: 'Express listen', regex: /\.listen\s*\(\s*\d+/ },
  {
    category: 'http',
    label: 'Node HTTP request handler',
    regex: /server\.on\s*\(\s*['"]request['"]\s*,/i,
  },

  // ── Cron / Scheduled ―─
  { category: 'cron', label: 'Cron schedule', regex: /cron\.schedule\s*\(/i },
  { category: 'cron', label: 'Agenda job definition', regex: /agenda\.define\s*\(/i },
  { category: 'cron', label: 'Bull/BullMQ queue processor', regex: /\.process\s*\(/i },

  // ── SvelteKit ──
  {
    category: 'http',
    label: 'SvelteKit server handler',
    regex: /export\s+(async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH)\s*\(/,
  },

  // ── Generic event handler ──
  {
    category: 'event',
    label: 'Event emitter listener',
    regex: /\.on\s*\(\s*['"](?!error|close|end|data)['"]/i,
  },
];

/** Result of a reachability analysis for a single finding. */
export interface ReachabilityResult {
  /** True if the finding is only a theoretical risk (not reachable from user input) */
  theoreticalRisk: boolean;
  /** Human-readable label of the nearest entry point, if reachable */
  entryPointPath?: string;
  /** The file path of the entry point */
  entryPointFile?: string;
}

/**
 * Analyze whether a security finding is reachable from user input.
 * Uses lightweight pattern matching and import graph traversal.
 *
 * @param filePath - Absolute or relative path to the flagged source file.
 * @param lineNumber - Line number of the finding within the file.
 * @param workDir - Working directory (repo root) for resolving imports.
 * @returns Reachability analysis result.
 */
export async function analyzeFindingReachability(
  filePath: string,
  _lineNumber: number,
  workDir: string,
): Promise<ReachabilityResult> {
  const absolutePath = path.resolve(workDir, filePath);

  if (!fs.existsSync(absolutePath)) {
    logger.debug(`File not found for reachability: ${absolutePath}`);
    return { theoreticalRisk: true };
  }

  const visited = new Set<string>();
  const entryPointPatterns = ENTRY_POINT_PATTERNS;

  const queue: Array<{ file: string; depth: number }> = [{ file: absolutePath, depth: 0 }];
  const maxDepth = 3;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current.file)) continue;
    visited.add(current.file);

    try {
      const content = fs.readFileSync(current.file, 'utf-8');

      // Check for entry point patterns in this file
      for (const pattern of entryPointPatterns) {
        const match = content.match(pattern.regex);
        if (match) {
          return {
            theoreticalRisk: false,
            entryPointPath: pattern.label,
            entryPointFile: current.file,
          };
        }
      }

      // If at the flagged file itself, also check for direct handler/export patterns
      if (current.depth === 0) {
        const directHandlerMatch = content.match(
          /(?:exports|module\.exports|export\s+default)\s*[=(]?\s*function\s*\(/,
        );
        if (directHandlerMatch) {
          return {
            theoreticalRisk: false,
            entryPointPath: 'Module export handler',
            entryPointFile: current.file,
          };
        }

        // Check if file is in well-known API route directories
        const relativePath = path.relative(workDir, current.file).replace(/\\/g, '/');
        if (
          /^pages\/api\//.test(relativePath) ||
          /^app\/api\//.test(relativePath) ||
          /\+server\.(ts|js)$/.test(relativePath) ||
          /route\.(ts|js)$/.test(relativePath)
        ) {
          return {
            theoreticalRisk: false,
            entryPointPath: 'Framework API route',
            entryPointFile: current.file,
          };
        }
      }

      // Walk imports up to maxDepth
      if (current.depth < maxDepth) {
        const imports = extractImports(content, current.file);
        for (const imp of imports) {
          if (!visited.has(imp)) {
            queue.push({ file: imp, depth: current.depth + 1 });
          }
        }
      }
    } catch {
      logger.debug(`Could not read file for reachability: ${current.file}`);
    }
  }

  // No entry point found in the file or its imports (up to maxDepth)
  return { theoreticalRisk: true };
}

/**
 * Extract imported file paths from source code.
 * Supports both ESM `import` and CommonJS `require`.
 * Only resolves local imports (starting with `.` or `..`).
 *
 * @param content - Source file content.
 * @param sourceFile - Absolute path to the source file (for resolving relative imports).
 * @returns Array of resolved absolute file paths.
 */
function extractImports(content: string, sourceFile: string): string[] {
  const imports: string[] = [];
  const sourceDir = path.dirname(sourceFile);

  const importRe =
    /(?:import\s+(?:[\w*{}\s,]+?\s+from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\))/g;
  let match: RegExpExecArray | null;

  while ((match = importRe.exec(content)) !== null) {
    const specifier = match[1] || match[2];
    if (!specifier || !specifier.startsWith('.')) continue;

    // Try resolving with common extensions
    const resolved = resolveLocalImport(sourceDir, specifier);
    if (resolved) imports.push(resolved);
  }

  return imports;
}

/**
 * Resolve a local import specifier to an absolute file path.
 * Tries common extensions (.ts, .tsx, .js, .jsx, .mjs, .cjs, /index.ts, etc.).
 *
 * @param sourceDir - Directory of the importing file.
 * @param specifier - Import specifier from source (e.g. './foo', '../bar/baz').
 * @returns Resolved absolute file path, or undefined if not found.
 */
function resolveLocalImport(sourceDir: string, specifier: string): string | undefined {
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
  const basePath = path.resolve(sourceDir, specifier);

  // Try exact path first
  if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
    return basePath;
  }

  // Try with extensions
  for (const ext of extensions) {
    const withExt = basePath + ext;
    if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
      return withExt;
    }
  }

  // Try as directory with index file
  for (const ext of extensions) {
    const indexPath = path.join(basePath, `index${ext}`);
    if (fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()) {
      return indexPath;
    }
  }

  return undefined;
}

/**
 * Run reachability analysis on a batch of findings.
 * For each finding, checks if the flagged code is reachable from a user-input entry point.
 *
 * @param findings - Array of issue findings with file/line info.
 * @param workDir - Working directory for resolving file paths.
 * @returns Array of results aligned with the input findings array.
 */
export async function analyzeBatchReachability(
  findings: Array<{ file: string; line: number }>,
  workDir: string,
): Promise<ReachabilityResult[]> {
  const results: ReachabilityResult[] = await Promise.all(
    findings.map(async (f) => {
      try {
        return await analyzeFindingReachability(f.file, f.line, workDir);
      } catch {
        return { theoreticalRisk: true };
      }
    }),
  );
  return results;
}
