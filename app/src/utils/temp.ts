import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Create a uniquely-named temporary directory (async, non-blocking).
 * @param prefix - Directory name prefix (joined onto the OS temp dir).
 * @returns The created directory path.
 */
export async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Contents of the GIT_ASKPASS credential helper script. The token is passed
 * via the OPENCODE_CREDENTIAL_TOKEN environment variable so it never appears
 * in argv or `.git/config`.
 */
const ASKPASS_SCRIPT = [
  '#!/bin/sh',
  'case "$1" in',
  '  *Username*) echo "x-access-token" ;;',
  '  *Password*) echo "${OPENCODE_CREDENTIAL_TOKEN}" ;;',
  '  *) exit 0 ;;',
  'esac',
].join('\n');

/**
 * Create a temporary directory holding an executable GIT_ASKPASS credential
 * helper script (async, non-blocking).
 * @returns The helper directory and the script path inside it.
 */
export async function createAskpassScript(): Promise<{ dir: string; scriptPath: string }> {
  const dir = await createTempDir('opencode-askpass-');
  const scriptPath = path.join(dir, 'credential.sh');
  await writeFile(scriptPath, ASKPASS_SCRIPT, { encoding: 'utf-8', mode: 0o700 });
  return { dir, scriptPath };
}

/**
 * Recursively remove a directory, ignoring missing paths (async,
 * non-blocking). Never throws for absent directories.
 * @param dir - Directory to remove.
 */
export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Async existence check for a filesystem path.
 * @param targetPath - Path to probe.
 * @returns True when the path is accessible.
 */
export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}
