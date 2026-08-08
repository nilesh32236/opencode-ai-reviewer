/**
 * Shared changelog file helpers used by both the action and app paths so the
 * changelog file format and path resolution cannot diverge between runtimes.
 */

import path from 'path';

/**
 * Prepend the generated changelog entry to an existing changelog file, creating
 * a `# Changelog` file from scratch when none exists.
 * @param newEntry - The generated markdown release-notes entry.
 * @param existing - Existing changelog file content, or null.
 * @returns The full new changelog file content.
 */
export function buildChangelogFileContent(newEntry: string, existing: string | null): string {
  const entry = newEntry.trim();
  if (!existing || existing.trim() === '') {
    return `# Changelog\n\n${entry}\n`;
  }
  return `${entry}\n\n---\n\n${existing.trim()}\n`;
}

/**
 * Resolve a repository-relative changelog file path against a working root.
 * Rejects absolute paths and values that escape the root via parent traversal.
 * @param filePath - Repo-relative changelog file path (e.g. 'CHANGELOG.md').
 * @param root - Absolute working-directory root to resolve against.
 * @returns The absolute resolved path, guaranteed to be inside `root`.
 */
export function resolveChangelogFilePath(filePath: string, root: string): string {
  if (path.isAbsolute(filePath)) {
    throw new Error(
      `changelog.filePath must be repository-relative, got absolute path: ${filePath}`,
    );
  }
  const normalized = path.normalize(filePath);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`changelog.filePath must not escape the working directory, got: ${filePath}`);
  }
  const resolved = path.resolve(root, normalized);
  const rootPrefix = `${path.resolve(root)}${path.sep}`;
  if (resolved !== path.resolve(root) && !resolved.startsWith(rootPrefix)) {
    throw new Error(`changelog.filePath must not escape the working directory, got: ${filePath}`);
  }
  return resolved;
}
