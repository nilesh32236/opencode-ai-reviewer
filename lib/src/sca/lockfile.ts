// Lock-file detection and dependency extraction for the SCA pass.
//
// Supports the seven manifest formats listed in the issue:
// `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`,
// `requirements.txt`, `go.sum`, and `Gemfile.lock`.
//
// Dependencies are extracted from the **added lines** of the unified diff patch
// (`ChangedFile.patch`) so only dependencies added or updated by the PR are
// reported — never pre-existing ones. Each added line is mapped to its new-file
// line number so findings can be posted as accurate inline comments. When a
// changed lock file has no patch (e.g. large patches omitted by the platform),
// the full file is read from the working tree as a best-effort fallback.

import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import type { ChangedFile } from '../types/index.js';
import type { Ecosystem, SCADependency } from './types.js';

/** Unified diff hunk header regex: extracts the new-file start line. */
const HUNK_REGEX = /^@@\s+-[0-9,]+\s+\+([0-9]+)(?:,[0-9]+)?\s+@@/;

/** Max bytes read for the full-file fallback (large lock files are skipped). */
const MAX_SCA_READ_BYTES = 10 * 1024 * 1024;

/** A single line of a unified diff patch annotated for new-file line mapping. */
export interface PatchLine {
  /** 1-based new-file line number. For deleted-only lines this is the position
   * that the surrounding context/additions advance, used only as a best guess. */
  line: number;
  /** Line content with the `+` / `-` / ` ` diff prefix stripped. */
  text: string;
  /** Whether this line is an addition in the new file. */
  added: boolean;
  /** Whether this line is a deletion (consumes no new-file line). */
  deleted: boolean;
}

/**
 * Walk a unified diff patch and annotate every line inside hunks with its
 * new-file line number. Context (` `) and addition (`+`) lines advance the
 * new-file counter; deletions (`-`) do not. File headers (`---` / `+++`) and
 * hunk bodies cut off by truncation are naturally excluded.
 *
 * @param patch - Unified diff patch content for a changed file.
 * @returns Annotated patch lines in source order.
 */
export function parsePatchLines(patch: string): PatchLine[] {
  const lines: PatchLine[] = [];
  if (!patch) return lines;
  let inHunk = false;
  let lineNum = 0;
  for (const rawLine of patch.split('\n')) {
    const match = HUNK_REGEX.exec(rawLine);
    if (match) {
      inHunk = true;
      lineNum = Number.parseInt(match[1], 10);
      continue;
    }
    if (!inHunk) continue;
    const prefix = rawLine[0];
    if (prefix === '+') {
      if (rawLine.startsWith('+++')) continue;
      lines.push({ line: lineNum, text: rawLine.slice(1), added: true, deleted: false });
      lineNum++;
    } else if (prefix === '-') {
      if (rawLine.startsWith('---')) continue;
      lines.push({ line: lineNum, text: rawLine.slice(1), added: false, deleted: true });
    } else if (prefix === ' ') {
      lines.push({ line: lineNum, text: rawLine.slice(1), added: false, deleted: false });
      lineNum++;
    }
    // Other prefixes (e.g. `\` for "\ No newline at end of file") are ignored.
  }
  return lines;
}

/** The seven lock file / manifest types supported by the SCA pass. */
export type LockFileType =
  | 'package-lock.json'
  | 'yarn.lock'
  | 'pnpm-lock.yaml'
  | 'Cargo.lock'
  | 'requirements.txt'
  | 'go.sum'
  | 'Gemfile.lock';

/**
 * Detect whether a repo-relative path refers to a supported lock file.
 *
 * @param filePath - Repo-relative path of a changed file.
 * @returns The detected lock file type and OSV ecosystem, or null.
 */
export function detectLockFileType(
  filePath: string,
): { type: LockFileType; ecosystem: Ecosystem } | null {
  const base = path.basename(filePath);
  switch (base) {
    case 'package-lock.json':
      return { type: 'package-lock.json', ecosystem: 'npm' };
    case 'yarn.lock':
      return { type: 'yarn.lock', ecosystem: 'npm' };
    case 'pnpm-lock.yaml':
      return { type: 'pnpm-lock.yaml', ecosystem: 'npm' };
    case 'Cargo.lock':
      return { type: 'Cargo.lock', ecosystem: 'crates.io' };
    case 'requirements.txt':
      return { type: 'requirements.txt', ecosystem: 'pypi' };
    case 'go.sum':
      return { type: 'go.sum', ecosystem: 'go' };
    case 'Gemfile.lock':
      return { type: 'Gemfile.lock', ecosystem: 'rubygems' };
    default:
      return null;
  }
}

// ─── npm / yarn / pnpm ────────────────────────────────────

/** `"node_modules/<pkg>": {` / `"<pkg>": {` package keys (npm lockfiles). */
const NPM_PACKAGE_KEY =
  /^\s*"((?:node_modules\/)?(@?[^"/]+(?:\/[^"/]+)?))":\s*\{?$/;

/** `"version": "x.y.z"` lines (npm lockfiles). */
const NPM_VERSION = /^\s*"version":\s*"([^"]+)",?\s*$/;

/** Structural keys that never represent a package (reset name tracking). */
const NPM_CONTAINER_KEYS = new Set([
  'packages',
  'dependencies',
  'optionalDependencies',
  'devDependencies',
  'peerDependencies',
  'bundledDependencies',
  'requires',
  'engines',
]);

/**
 * Parse npm `package-lock.json` lines. Package name keys may be context or
 * added lines; a dependency is only emitted when the *version* line is added
 * (i.e. the version genuinely changed in the PR).
 *
 * @param lines - Annotated patch (or full-file) lines.
 * @param file - Repo-relative lock file path.
 * @returns Parsed dependencies.
 */
function parseNpmLockfile(lines: PatchLine[], file: string): SCADependency[] {
  const deps: SCADependency[] = [];
  let currentPackage: string | null = null;
  for (const pl of lines) {
    const keyMatch = NPM_PACKAGE_KEY.exec(pl.text);
    if (keyMatch) {
      const raw = keyMatch[1].replace(/^node_modules\//, '');
      currentPackage = NPM_CONTAINER_KEYS.has(raw) ? null : raw;
      continue;
    }
    if (!pl.added) continue;
    const verMatch = NPM_VERSION.exec(pl.text);
    if (verMatch && currentPackage) {
      deps.push({
        file,
        line: pl.line,
        name: currentPackage,
        version: verMatch[1],
        ecosystem: 'npm',
      });
    }
  }
  return deps;
}

/** yarn.lock v1/v2 block keys like `"foo@^1.0.0":` or `"@babel/core@^7.0.0":`. */
const YARN_KEY = /^"?(.+?)":\s*$/;

/** yarn.lock version lines: `version "1.0.0"` (v1) or `version: 1.0.1` (v2). */
const YARN_VERSION = /^\s+version\s+"?([^"\s]+)"?/;

/**
 * Extract the bare package name from a yarn.lock key spec. Handles scoped
 * packages (`@babel/core@^7.0.0` → `@babel/core`) and multi-spec keys
 * (`foo@^1.0.0, foo@^2.0.0` → `foo`).
 *
 * @param key - The key text between quotes.
 * @returns The package name, or null when no range separator is present.
 */
function parseYarnName(key: string): string | null {
  const entry = key.split(',')[0]?.trim();
  if (!entry) return null;
  const at = entry.indexOf('@');
  if (at < 0) return null;
  if (at === 0) {
    const second = entry.indexOf('@', 1);
    if (second < 0) return null;
    return entry.slice(0, second);
  }
  return entry.slice(0, at);
}

/**
 * Parse yarn.lock lines. Block keys (context or added) set the current package;
 * an added `version` line emits the dependency.
 *
 * @param lines - Annotated patch (or full-file) lines.
 * @param file - Repo-relative lock file path.
 * @returns Parsed dependencies.
 */
function parseYarnLockfile(lines: PatchLine[], file: string): SCADependency[] {
  const deps: SCADependency[] = [];
  let currentPackage: string | null = null;
  for (const pl of lines) {
    const keyMatch = YARN_KEY.exec(pl.text);
    if (keyMatch) {
      currentPackage = parseYarnName(keyMatch[1].replace(/^"|"$/g, ''));
      continue;
    }
    if (!pl.added) continue;
    const verMatch = YARN_VERSION.exec(pl.text);
    if (verMatch && currentPackage) {
      deps.push({
        file,
        line: pl.line,
        name: currentPackage,
        version: verMatch[1],
        ecosystem: 'npm',
      });
    }
  }
  return deps;
}

/** pnpm-lock.yaml package keys: `  /@babel/code-frame@7.18.6:` or `  'vue@3.2.47':`. */
const PNPM_KEY = /^\s*'?\/?(@?[a-z0-9._~-]+(?:\/[a-z0-9._~-]+)?)@(\d[^)\s:']*)/i;

/**
 * Parse pnpm-lock.yaml lines. Each added package key carries the resolved
 * version inline, so added keys emit directly; context keys are skipped so only
 * packages actually touched by the PR are reported.
 *
 * @param lines - Annotated patch (or full-file) lines.
 * @param file - Repo-relative lock file path.
 * @returns Parsed dependencies.
 */
function parsePnpmLockfile(lines: PatchLine[], file: string): SCADependency[] {
  const deps: SCADependency[] = [];
  for (const pl of lines) {
    if (!pl.added) continue;
    const match = PNPM_KEY.exec(pl.text);
    if (match) {
      deps.push({
        file,
        line: pl.line,
        name: match[1],
        version: match[2],
        ecosystem: 'npm',
      });
    }
  }
  return deps;
}

// ─── Cargo / Python / Go / Ruby ───────────────────────────

/** Cargo.lock `name = "..."` lines. */
const CARGO_NAME = /^\s*name\s*=\s*"([^"]+)"/;

/** Cargo.lock `version = "..."` lines. */
const CARGO_VERSION = /^\s*version\s*=\s*"([^"]+)"/;

/**
 * Parse Cargo.lock lines. `name = "..."` (context or added) sets the current
 * package; an added `version = "..."` line emits the dependency. The top-level
 * `version = 3` lockfile-format line emits nothing because no package name has
 * been seen yet.
 *
 * @param lines - Annotated patch (or full-file) lines.
 * @param file - Repo-relative lock file path.
 * @returns Parsed dependencies.
 */
function parseCargoLockfile(lines: PatchLine[], file: string): SCADependency[] {
  const deps: SCADependency[] = [];
  let currentName: string | null = null;
  for (const pl of lines) {
    const nameMatch = CARGO_NAME.exec(pl.text);
    if (nameMatch) {
      currentName = nameMatch[1];
      continue;
    }
    if (!pl.added) continue;
    const verMatch = CARGO_VERSION.exec(pl.text);
    if (verMatch && currentName) {
      deps.push({
        file,
        line: pl.line,
        name: currentName,
        version: verMatch[1],
        ecosystem: 'crates.io',
      });
    }
  }
  return deps;
}

/** requirements.txt exact pins: `foo==1.2.3` (trailing `;` markers excluded). */
const REQUIREMENTS_PIN = /^\s*([^\s=<>!~\[;]+)==([^\s;]+)/;

/**
 * Parse requirements.txt lines. Only added exact pins are reported — range
 * specifiers (`>=`, `~=`) and deleted lines are ignored.
 *
 * @param lines - Annotated patch (or full-file) lines.
 * @param file - Repo-relative lock file path.
 * @returns Parsed dependencies.
 */
function parseRequirementsTxt(lines: PatchLine[], file: string): SCADependency[] {
  const deps: SCADependency[] = [];
  for (const pl of lines) {
    if (!pl.added) continue;
    const match = REQUIREMENTS_PIN.exec(pl.text);
    if (match) {
      deps.push({
        file,
        line: pl.line,
        name: match[1].trim(),
        version: match[2],
        ecosystem: 'pypi',
      });
    }
  }
  return deps;
}

/** go.sum module lines: `module v1.2.3 h1:<hash>` (the `/go.mod` lines excluded). */
const GO_SUM = /^(\S+) (\S+) h1:/;

/**
 * Parse go.sum lines. Only added module lines (whose version is a real version,
 * not a `/go.mod` checksum entry) are reported.
 *
 * @param lines - Annotated patch (or full-file) lines.
 * @param file - Repo-relative lock file path.
 * @returns Parsed dependencies.
 */
function parseGoSum(lines: PatchLine[], file: string): SCADependency[] {
  const deps: SCADependency[] = [];
  for (const pl of lines) {
    if (!pl.added) continue;
    const match = GO_SUM.exec(pl.text);
    if (match && !match[2].includes('/')) {
      deps.push({
        file,
        line: pl.line,
        name: match[1],
        version: match[2],
        ecosystem: 'go',
      });
    }
  }
  return deps;
}

/** Gemfile.lock specs: `    foo (1.2.3)` (requirement lines like `(~> 1.2)` excluded). */
const GEM_SPEC = /^\s+([\w-]+) \((\d[^)]*)\)/;

/**
 * Parse Gemfile.lock lines. Only added spec entries whose version starts with a
 * digit are reported; `DEPENDENCIES` requirement lines (`foo (~> 1.2)`) do not
 * match because their version does not start with a digit.
 *
 * @param lines - Annotated patch (or full-file) lines.
 * @param file - Repo-relative lock file path.
 * @returns Parsed dependencies.
 */
function parseGemfileLock(lines: PatchLine[], file: string): SCADependency[] {
  const deps: SCADependency[] = [];
  for (const pl of lines) {
    if (!pl.added) continue;
    const match = GEM_SPEC.exec(pl.text);
    if (match) {
      deps.push({
        file,
        line: pl.line,
        name: match[1],
        version: match[2].trim(),
        ecosystem: 'rubygems',
      });
    }
  }
  return deps;
}

/** Options controlling which changed files are scanned. */
export interface ExtractOptions {
  /** Glob patterns identifying lock files to scan. */
  lockFilePatterns: string[];
  /** Glob patterns for lock files to skip. */
  excludePatterns: string[];
}

/**
 * Dispatch an annotated line list to the parser for the given lock file type.
 *
 * @param type - Detected lock file type.
 * @param ecosystem - Detected ecosystem.
 * @param lines - Annotated lines (patch or full-file).
 * @param file - Repo-relative lock file path.
 * @returns Parsed dependencies.
 */
function parseLockfileContent(
  type: LockFileType,
  ecosystem: Ecosystem,
  lines: PatchLine[],
  file: string,
): SCADependency[] {
  switch (type) {
    case 'package-lock.json':
      return parseNpmLockfile(lines, file);
    case 'yarn.lock':
      return parseYarnLockfile(lines, file);
    case 'pnpm-lock.yaml':
      return parsePnpmLockfile(lines, file);
    case 'Cargo.lock':
      return parseCargoLockfile(lines, file);
    case 'requirements.txt':
      return parseRequirementsTxt(lines, file);
    case 'go.sum':
      return parseGoSum(lines, file);
    case 'Gemfile.lock':
      return parseGemfileLock(lines, file);
    default:
      return [];
  }
}

/**
 * Best-effort read of a changed lock file from the working tree. Returns null
 * when the file is missing or larger than the read cap.
 *
 * @param workDir - Working directory the file is checked out under.
 * @param file - Repo-relative path.
 * @returns The file content lines, or null.
 */
async function readFileLines(workDir: string, file: string): Promise<string[] | null> {
  const fullPath = path.join(workDir, file);
  try {
    const stat = await fs.stat(fullPath);
    if (stat.size > MAX_SCA_READ_BYTES) return null;
    const content = await fs.readFile(fullPath, 'utf-8');
    return content.split('\n');
  } catch {
    return null;
  }
}

/**
 * Extract added/updated dependencies from a set of changed files. Only files
 * matching `lockFilePatterns` (and not `excludePatterns`) are considered; each
 * is parsed from the added lines of its diff patch. When a lock file has no
 * patch, the full file is read from the working tree as a fallback.
 *
 * @param changedFiles - Changed files for the PR (unfiltered by review excludes).
 * @param workDir - Working directory the files are checked out under.
 * @param options - Lock file pattern filtering options.
 * @returns Parsed dependencies (empty when no lock files changed).
 */
export async function extractChangedDependencies(
  changedFiles: ChangedFile[],
  workDir: string,
  options: ExtractOptions,
): Promise<SCADependency[]> {
  const deps: SCADependency[] = [];
  for (const file of changedFiles) {
    if (!file?.path) continue;
    if (
      !options.lockFilePatterns.some((pattern) => minimatch(file.path, pattern)) ||
      options.excludePatterns.some((pattern) => minimatch(file.path, pattern))
    ) {
      continue;
    }
    const detected = detectLockFileType(file.path);
    if (!detected) continue;

    if (file.patch) {
      deps.push(
        ...parseLockfileContent(detected.type, detected.ecosystem, parsePatchLines(file.patch), file.path),
      );
      continue;
    }

    // No patch available (large patch omitted / platform without diffs):
    // fall back to reading the new file from the working tree.
    const contentLines = await readFileLines(workDir, file.path);
    if (!contentLines) continue;
    const fullLines: PatchLine[] = contentLines.map((text, i) => ({
      line: i + 1,
      text,
      added: true,
      deleted: false,
    }));
    deps.push(...parseLockfileContent(detected.type, detected.ecosystem, fullLines, file.path));
  }
  return deps;
}
