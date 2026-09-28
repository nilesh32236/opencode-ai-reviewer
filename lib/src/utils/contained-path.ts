import { existsSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolve a repository- or operator-controlled relative path against a base
 * directory, refusing anything that would escape that directory.
 *
 * This is the single containment guard shared by every "write a repo file"
 * flow (changelog, docs, etc.) in both the Action and the App. It is
 * deliberately the *strongest* of its predecessors: a purely lexical
 * `path.resolve` + prefix check is not sufficient, because a symlink created
 * inside the base directory (a symlinked target file, or a symlinked parent
 * directory) can redirect the write outside the base while still satisfying
 * the prefix test. So this helper additionally
 *
 * 1. rejects a symlinked target file, and
 * 2. realpaths the nearest *existing* ancestor of the target and re-checks
 *    containment from there, replaying the not-yet-created path segments.
 *
 * Returning `null` (rather than throwing) keeps call sites free of
 * try/catch noise; wrappers that want a thrown error can map `null` to one.
 *
 * @param baseDir - Containing directory the resolved path must stay inside.
 * @param rawPath - Untrusted relative path from config or a comment body.
 * @returns The resolved absolute path, or `null` when it escapes `baseDir`,
 * is empty, or resolves to `baseDir` itself.
 */
export function resolveContainedPath(baseDir: string, rawPath: string): string | null {
  if (!rawPath || rawPath.trim() === '') return null;
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, rawPath);
  if (resolved === base || !resolved.startsWith(base + path.sep)) return null;
  // A symlinked filePath pointing outside still escapes containment — reject
  // it (a path that does not exist yet cannot be a symlink, so skip those).
  try {
    if (lstatSync(resolved).isSymbolicLink()) return null;
  } catch {
    // Not yet created — no symlink to escape through; fall through to the
    // parent-dir realpath check below.
  }
  // A symlinked parent dir could also escape: realpath the nearest existing
  // ancestor and re-verify containment from there.
  let dir = path.dirname(resolved);
  const missing: string[] = [];
  while (!existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    missing.unshift(path.basename(dir));
    dir = parent;
  }
  const realBase = realpathSync(base);
  const contained = path.join(realpathSync(dir), ...missing);
  if (contained !== realBase && !contained.startsWith(realBase + path.sep)) return null;
  return resolved;
}
