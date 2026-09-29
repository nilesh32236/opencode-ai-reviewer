import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonDatabase } from '../src/learning/json-db.js';

// The Action writes learning state under the workspace checkout, so a branch
// can place a file or symlink at a known path. The previous implementation wrote
// to a fixed `<path>.tmp` with `writeFileSync`, which FOLLOWS a symlink — the
// write landed wherever the link pointed, and the following renameSync left
// `learning.json` itself a symlink (rename does not dereference).
describe('JsonDatabase atomic write', () => {
  const databases: JsonDatabase[] = [];
  const tempDirs: string[] = [];

  const makeDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-json-atomic-'));
    tempDirs.push(dir);
    return dir;
  };

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.close()));
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not follow a symlink planted at the state path', async () => {
    const dir = makeDir();
    const target = path.join(dir, 'secret.txt');
    fs.writeFileSync(target, 'ORIGINAL-CONTENT');

    // The attacker-controlled checkout ships this, pointing anywhere it likes.
    const link = path.join(dir, 'learning.json');
    fs.symlinkSync(target, link);

    const db = new JsonDatabase(link);
    databases.push(db);
    db.data.patterns.push({ id: 'p1', pattern: 'x' } as never);
    await db.flush();

    // The planted target must be untouched...
    expect(fs.readFileSync(target, 'utf-8')).toBe('ORIGINAL-CONTENT');
    // ...and the state file must be a real file, not still a link.
    const stat = fs.lstatSync(link);
    expect(stat.isSymbolicLink(), 'learning.json is still a symlink').toBe(false);
  });

  it('leaves a regular file intact and readable after an atomic write', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'learning.json');
    const db = new JsonDatabase(file);
    databases.push(db);

    db.data.patterns.push({ id: 'p1', pattern: 'x' } as never);
    await db.flush();
    db.data.patterns.push({ id: 'p2', pattern: 'y' } as never);
    await db.flush();

    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.patterns).toHaveLength(2);
    expect(parsed.patterns[1].id).toBe('p2');
  });

  it('writes the state file owner-only', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'learning.json');
    const db = new JsonDatabase(file);
    databases.push(db);

    db.data.patterns.push({ id: 'p1', pattern: 'x' } as never);
    await db.flush();

    // 0600 — the learning state is readable only by its owner.
    const mode = fs.lstatSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('leaves no temp files behind after a successful write', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'learning.json');
    const db = new JsonDatabase(file);
    databases.push(db);

    db.data.patterns.push({ id: 'p1', pattern: 'x' } as never);
    await db.flush();

    const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('sync flush is atomic too', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'learning.json');
    const db = new JsonDatabase(file);
    databases.push(db);

    db.data.patterns.push({ id: 'p1', pattern: 'x' } as never);
    db.flushSync();

    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.patterns).toHaveLength(1);
    const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});
