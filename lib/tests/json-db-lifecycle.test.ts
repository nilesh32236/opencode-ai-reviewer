import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonDatabase } from '../src/learning/json-db.js';

describe('JsonDatabase process lifecycle', () => {
  const databases: JsonDatabase[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  it('uses one beforeExit listener for multiple databases and removes them on close', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-json-db-lifecycle-'));
    const initialListenerCount = process.listenerCount('beforeExit');

    try {
      for (let index = 0; index < 12; index++) {
        databases.push(new JsonDatabase(path.join(tempDir, `database-${index}.json`)));
      }

      expect(process.listenerCount('beforeExit')).toBe(initialListenerCount);

      await databases[0].close();
      databases.shift();
      expect(process.listenerCount('beforeExit')).toBe(initialListenerCount);

      await Promise.all(databases.splice(0).map((database) => database.close()));
      expect(process.listenerCount('beforeExit')).toBe(initialListenerCount);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
