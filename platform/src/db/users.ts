/**
 * User persistence for the platform dashboard auth. The `users` table is
 * created by migration 001; these helpers handle upsert-on-first-login and
 * role lookup.
 */

import type { DbRow, PlatformDb } from './client.js';

/** A user row from the users table. */
export interface UserRow extends DbRow {
  id: string;
  github_id: number;
  github_login: string;
  avatar_url: string | null;
  role: 'admin' | 'reviewer' | 'viewer';
  created_at: Date;
  updated_at: Date;
}

/**
 * Upsert a user by their GitHub id, returning the stored row. Creates the user
 * on first login (default role 'reviewer') and updates login/avatar on later
 * logins.
 * @param db - The platform database.
 * @param user - The GitHub identity from the OAuth profile.
 * @param user.id - GitHub user id.
 * @param user.login - GitHub login.
 * @param user.avatar - Avatar URL.
 * @returns The stored user row.
 */
export async function upsertUser(
  db: PlatformDb,
  user: { id: number; login: string; avatar?: string | null },
): Promise<UserRow> {
  const avatar = user.avatar?.trim() ? user.avatar : null;
  const rows = await db.query<UserRow>(
    `INSERT INTO users (github_id, github_login, avatar_url)
     VALUES ($1, $2, $3)
     ON CONFLICT (github_id) DO UPDATE SET
       github_login = EXCLUDED.github_login,
       avatar_url = EXCLUDED.avatar_url,
       updated_at = NOW()
     RETURNING *`,
    [user.id, user.login, avatar],
  );
  if (!rows.length) throw new Error('Failed to upsert user');
  return rows[0];
}

/**
 * Load a user by GitHub id.
 * @param db - The platform database.
 * @param githubId - The GitHub user id.
 * @returns The user row, or undefined.
 */
export async function getUserByGithubId(
  db: PlatformDb,
  githubId: number,
): Promise<UserRow | undefined> {
  return db.queryOne<UserRow>('SELECT * FROM users WHERE github_id = $1', [githubId]);
}

/**
 * Load a user by internal id (from a session JWT).
 * @param db - The platform database.
 * @param id - The user's internal UUID.
 * @returns The user row, or undefined.
 */
export async function getUserById(db: PlatformDb, id: string): Promise<UserRow | undefined> {
  return db.queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
}
