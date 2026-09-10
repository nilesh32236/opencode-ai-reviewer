/**
 * Heuristics for recognising generated, vendored, or minified artifacts.
 *
 * Static analysis passes (LLM review, hardcoded-secret scanning, test-gap
 * detection, and reachability) are only meaningful on human-authored source.
 * Build outputs, committed bundles, vendored dependencies, and minified files
 * otherwise produce a stream of false positives — most visibly the scanner
 * flagging its own committed npm/rollup bundle as a hardcoded high-entropy
 * secret. Excluding them keeps findings high-signal and keeps analysis fast
 * (a multi-megabyte bundle is never read or tokenized).
 *
 * Two complementary signals are used because neither is sufficient alone:
 * a path-based check (directory/segment names) and a cheap content-based
 * check (a single very long line, or a bundler source-map trailer) that also
 * catches generated files living under an ordinary-looking name.
 *
 * @module utils/generated-files
 */

/**
 * Directory segments that mark build output, vendored code, or caches. A file
 * is treated as generated when any non-final segment of its path matches one
 * of these names.
 */
const GENERATED_DIR_SEGMENTS: ReadonlySet<string> = new Set([
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  'vendors',
  'node_modules',
  'bower_components',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  '.turbo',
  '.cache',
]);

/**
 * Final-segment patterns for machine-generated files regardless of directory:
 * `.min.`, `.bundle.`, `.generated.`, `.chunk.` with a script/style extension,
 * plus source maps.
 */
const GENERATED_FILE_RE =
  /(?:\.min|\.bundle|\.generated|\.chunk|\.d)\.(?:[cm]?[jt]sx?|css)$|\.map$/i;

/**
 * Paths that ship pre-bundled JavaScript into the repository. `action/lib` is
 * the committed @vercel/ncc bundle used by the GitHub Action distribution.
 */
const BUNDLED_ACTION_RE = /(?:^|\/)action\/lib\//;

/**
 * Directory segments that hold agent/authoring configuration rather than
 * reviewable source. These files churn frequently but rarely need
 * line-by-line code review, so they are default-excluded from LLM findings
 * (while still counted as skipped in the review summary).
 *
 * @since NEXT
 */
const AGENT_CONFIG_SEGMENTS: ReadonlySet<string> = new Set(['.agents', '.claude']);

/**
 * Basename pattern for agent skill definitions, matched case-insensitively
 * against the final path segment regardless of directory.
 *
 * @since NEXT
 */
const AGENT_CONFIG_BASENAME_RE = /^skill\.md$/i;

/**
 * A first line longer than this many characters is almost certainly a
 * minified bundle (human-authored lines are far shorter).
 */
const MINIFIED_FIRST_LINE_LENGTH = 2000;

/**
 * Determine whether a file path alone identifies a generated/vendored artifact.
 *
 * @param filePath - Repo-relative or absolute POSIX or Windows path.
 * @returns True when the path should be excluded from source analysis.
 */
export function isGeneratedArtifactPath(filePath: string): boolean {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, '/');
  if (BUNDLED_ACTION_RE.test(normalized)) return true;

  const segments = normalized.split('/');
  const lastIndex = segments.length - 1;
  for (let i = 0; i < lastIndex; i++) {
    if (GENERATED_DIR_SEGMENTS.has(segments[i])) return true;
  }
  const base = segments[lastIndex] ?? '';
  return GENERATED_FILE_RE.test(base);
}

/**
 * Determine whether a file path identifies agent/authoring configuration
 * (`.agents/`, `.claude/` directories or a `SKILL.md` file) that is
 * default-excluded from line-by-line review findings.
 *
 * This is intentionally a separate signal from {@link isGeneratedArtifactPath}
 * so existing generated-artifact consumers (secret scanning, bundle guards)
 * are unaffected.
 *
 * Fail-open: any error (or empty input) returns false so the file is
 * reviewed rather than silently dropped. Never throws.
 *
 * @param filePath - Repo-relative or absolute POSIX or Windows path.
 * @returns True when the path should be skipped for LLM findings.
 * @since NEXT
 */
export function isAgentConfigPath(filePath: string): boolean {
  try {
    if (!filePath) return false;
    const normalized = filePath.replace(/\\/g, '/');
    const segments = normalized.split('/');
    const lastIndex = segments.length - 1;
    for (let i = 0; i < lastIndex; i++) {
      if (AGENT_CONFIG_SEGMENTS.has(segments[i] ?? '')) return true;
    }
    const base = segments[lastIndex] ?? '';
    return AGENT_CONFIG_BASENAME_RE.test(base);
  } catch {
    return false;
  }
}

/**
 * Determine whether file contents look minified or bundler-generated.
 *
 * This is intentionally cheap: it inspects only the length of the first line
 * (no full parse) and looks for a bundler source-map trailer on large files.
 *
 * @param content - Decoded file contents (may be size-capped by the caller).
 * @returns True when the content appears machine-generated.
 */
export function isMinifiedContent(content: string): boolean {
  if (!content) return false;
  const newlineIndex = content.indexOf('\n');
  const firstLineLength = newlineIndex === -1 ? content.length : newlineIndex;
  if (firstLineLength > MINIFIED_FIRST_LINE_LENGTH) return true;
  if (content.length > 100_000 && content.includes('sourceMappingURL=')) return true;
  return false;
}

/**
 * Decide whether a file should be skipped by source-oriented static analysis.
 *
 * @param filePath - Repo-relative or absolute path of the file.
 * @param content - Optional decoded contents for the minification heuristic.
 * @returns True when the file is a generated/vendored/minified artifact.
 */
export function isGeneratedArtifact(filePath: string, content?: string): boolean {
  if (isGeneratedArtifactPath(filePath)) return true;
  if (content !== undefined && isMinifiedContent(content)) return true;
  return false;
}
