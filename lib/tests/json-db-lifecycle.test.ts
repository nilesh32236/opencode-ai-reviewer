import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonDatabase } from '../src/learning/json-db.js';
import { Logger } from '../src/utils/logger.js';

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

describe('JsonDatabase corrupt-file warning', () => {
  it('attaches the parse error cause to the fallback warning', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-json-db-corrupt-'));
    try {
      const dbPath = path.join(tempDir, 'corrupt.json');
      fs.writeFileSync(dbPath, '{not valid json', 'utf-8');
      const warnings: string[] = [];
      Logger.setSink({
        debug: () => {},
        info: () => {},
        warn: (message: string) => warnings.push(message),
        error: () => {},
      });
      try {
        const database = new JsonDatabase(dbPath);
        try {
          expect(database.data.findings).toEqual([]);
        } finally {
          await database.close();
        }
      } finally {
        Logger.resetSink();
      }
      const line = warnings.find((w) => w.includes('Failed to parse JSON database'));
      expect(line).toBeDefined();
      // The cause must be attached: something follows the message itself.
      expect(line!.trimEnd().endsWith('starting with empty data')).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
