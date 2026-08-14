/**
 * Workspace lifecycle manager for the platform.
 *
 * Each task (review/fix/audit) runs in an isolated directory under
 * `WORKSPACE_DIR/<owner>/<repo>/<pr-or-task-id>`. Workspaces are created on
 * demand (shallow clone), cleaned up after PR merge, and stale ones are
 * reclaimed to bound disk usage.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Logger } from '@opencode-pr-agent/lib';
import { execGit } from './git.js';

const logger = new Logger('WorkspaceManager');

/** Information about a managed workspace. */
export interface Workspace {
  /** Absolute path to the workspace root. */
  path: string;
  /** Owner of the repository. */
  owner: string;
  /** Repository name. */
  repo: string;
  /** PR number or task id the workspace serves. */
  id: string | number;
}

/** Result of a cleanup pass. */
export interface CleanupResult {
  /** Number of workspaces reclaimed. */
  reclaimed: number;
  /** Total bytes freed. */
  freedBytes: number;
}

/**
 * Manage per-task workspace directories.
 */
export class WorkspaceManager {
  /**
   * @param baseDir - Root directory for all workspaces (e.g. /data/workspaces).
   */
  constructor(private readonly baseDir: string) {}

  /**
   * Compute the workspace path for a repo + id.
   * @param repo - Repository in "owner/repo" form.
   * @param id - PR number or task id.
   * @returns The workspace path.
   */
  workspacePath(repo: string, id: number | string): string {
    const [owner = 'unknown', name = 'unknown'] = repo.split('/');
    return path.join(this.baseDir, owner, name, String(id));
  }

  /**
   * Create (or reuse) a workspace for a repo at a specific PR head.
   * Shallow-clones into the workspace dir if it does not already exist.
   * @param repo - Repository in "owner/repo" form.
   * @param id - PR number or task id.
   * @param cloneUrl - Clone URL (HTTPS with credentials handled by the caller,
   * or a token-free URL when the worker supplies its own auth via GIT_ASKPASS).
   * @param ref - Optional ref/branch to check out after clone.
   * @returns The workspace descriptor.
   */
  async create(
    repo: string,
    id: number | string,
    cloneUrl: string,
    ref?: string,
  ): Promise<Workspace> {
    const dir = this.workspacePath(repo, id);
    await fs.mkdir(path.dirname(dir), { recursive: true });

    const exists = await fs
      .access(path.join(dir, '.git'))
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      logger.info(`Cloning ${repo} into ${dir}`);
      await execGit(['clone', '--depth', '1', cloneUrl, dir]);
    }
    if (ref) {
      await execGit(['checkout', ref], { cwd: dir });
    }
    return { path: dir, owner: repo.split('/')[0] ?? '', repo, id };
  }

  /**
   * Remove a workspace directory and its contents.
   * @param workspace - The workspace to remove.
   */
  async cleanup(workspace: Workspace): Promise<void> {
    await fs.rm(workspace.path, { recursive: true, force: true });
    logger.info(`Removed workspace ${workspace.path}`);
  }

  /**
   * Compute the total on-disk size of a directory in bytes.
   * @param dir - Directory to measure.
   * @returns Total bytes, or 0 when the directory does not exist.
   */
  async dirSize(dir: string): Promise<number> {
    let total = 0;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          total += await this.dirSize(full);
        } else {
          const stat = await fs.stat(full);
          total += stat.size;
        }
      }
    } catch {
      return 0;
    }
    return total;
  }

  /**
   * Reclaim stale workspaces to bound disk usage.
   * @param maxAgeMs - Workspaces untouched longer than this are removed.
   * @returns The cleanup result.
   */
  async cleanupStale(maxAgeMs: number): Promise<CleanupResult> {
    const result: CleanupResult = { reclaimed: 0, freedBytes: 0 };
    const now = Date.now();

    const repos = await fs.readdir(this.baseDir).catch(() => []);
    for (const owner of repos) {
      const ownerDir = path.join(this.baseDir, owner);
      const names = await fs.readdir(ownerDir).catch(() => []);
      for (const name of names) {
        const repoDir = path.join(ownerDir, name);
        const ids = await fs.readdir(repoDir).catch(() => []);
        for (const id of ids) {
          const dir = path.join(repoDir, id);
          const stat = await fs.stat(dir).catch(() => null);
          if (!stat) continue;
          if (now - stat.mtimeMs > maxAgeMs) {
            const size = await this.dirSize(dir);
            await fs.rm(dir, { recursive: true, force: true });
            result.reclaimed++;
            result.freedBytes += size;
            logger.info(`Reclaimed stale workspace ${dir} (${size} bytes)`);
          }
        }
      }
    }
    return result;
  }
}
