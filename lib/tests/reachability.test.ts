import { describe, expect, it, vi } from 'vitest';

const { mockReadFile, mockAccess, mockStat } = vi.hoisted(() => {
  const _mockReadFile = vi.fn();
  const _mockAccess = vi.fn();
  const _mockStat = vi.fn();
  return {
    mockReadFile: _mockReadFile,
    mockAccess: _mockAccess,
    mockStat: _mockStat,
  };
});

vi.mock('node:fs', () => ({
  promises: {
    readFile: mockReadFile,
    access: mockAccess,
    stat: mockStat,
  },
}));

import { analyzeBatchReachability } from '../src/utils/reachability.js';

function mockFiles(entries: Record<string, string>): void {
  mockReadFile.mockImplementation(async (p: string) => {
    if (p in entries) return entries[p];
    throw new Error('ENOENT: ' + p);
  });
  mockAccess.mockImplementation(async (p: string) => {
    if (p in entries) return;
    throw new Error('ENOENT: ' + p);
  });
  mockStat.mockImplementation(async (p: string) => {
    if (p in entries) return { isFile: () => true };
    throw new Error('ENOENT: ' + p);
  });
}

function mockNoFiles(): void {
  mockReadFile.mockRejectedValue(new Error('ENOENT'));
  mockAccess.mockRejectedValue(new Error('ENOENT'));
  mockStat.mockRejectedValue(new Error('ENOENT'));
}

describe('analyzeFindingReachability', () => {
  const workDir = '/repo';

  beforeEach(() => {
    vi.clearAllMocks();
    mockNoFiles();
  });

  it('returns theoreticalRisk=true when file does not exist', async () => {
    const { analyzeFindingReachability } = await import('../src/utils/reachability.js');

    const result = await analyzeFindingReachability('src/nonexistent.ts', 42, workDir);
    expect(result).toEqual({ theoreticalRisk: true });
  });

  it('detects Express route handler and returns reachable', async () => {
    const { analyzeFindingReachability } = await import('../src/utils/reachability.js');
    mockFiles({
      '/repo/src/routes/user.ts': `
        import { Router } from 'express';
        const router = Router();
        router.get('/users', (req, res) => { res.json([]); });
        export default router;
      `,
    });

    const result = await analyzeFindingReachability('src/routes/user.ts', 5, workDir);
    expect(result.theoreticalRisk).toBe(false);
    expect(result.entryPointPath).toBe('Express Router handler');
    expect(result.entryPointFile).toBe('/repo/src/routes/user.ts');
  });

  it('returns theoreticalRisk=true when no entry point is found', async () => {
    const { analyzeFindingReachability } = await import('../src/utils/reachability.js');
    mockFiles({
      '/repo/src/utils/helper.ts': `
        export function formatDate(d: Date): string {
          return d.toISOString();
        }
      `,
    });

    const result = await analyzeFindingReachability('src/utils/helper.ts', 2, workDir);
    expect(result.theoreticalRisk).toBe(true);
    expect(result.entryPointPath).toBeUndefined();
    expect(result.entryPointFile).toBeUndefined();
  });

  it('traverses imports transitively up to maxDepth', async () => {
    const { analyzeFindingReachability } = await import('../src/utils/reachability.js');
    mockFiles({
      '/repo/src/deep/util.ts': `import { helper } from './middle.js';
      export function process(data: string) { return helper(data); }`,
      '/repo/src/deep/middle.ts': `import { http } from './../entry/server.js';
      export function helper(data: string) { return http(data); }`,
      '/repo/src/entry/server.ts': `import http from 'http';
      const server = http.createServer((req, res) => { res.end('ok'); });`,
    });

    const result = await analyzeFindingReachability('src/deep/util.ts', 1, workDir);
    expect(result.theoreticalRisk).toBe(false);
    expect(result.entryPointPath).toBe('HTTP server create');
  });

  it('stops at maxDepth=3 when entry point is at depth 4 (not walked)', async () => {
    const { analyzeFindingReachability } = await import('../src/utils/reachability.js');
    mockFiles({
      '/repo/src/a.ts': `import { b } from './b.js'; export const a = 1;`,
      '/repo/src/b.ts': `import { c } from './c.js'; export const b = 1;`,
      '/repo/src/c.ts': `import { d } from './d.js'; export const c = 1;`,
      '/repo/src/d.ts': `import { e } from './e.js'; export const d = 1;`,
      '/repo/src/e.ts': `import http from 'http';
      const server = http.createServer((req, res) => { res.end('ok'); });`,
    });

    const result = await analyzeFindingReachability('src/a.ts', 1, workDir);
    expect(result.theoreticalRisk).toBe(true);
  });

  it('detects Next.js API route with export function handler', async () => {
    const { analyzeFindingReachability } = await import('../src/utils/reachability.js');
    mockFiles({
      '/repo/app/api/users/route.ts': `export async function GET(req: Request) {
        return Response.json({ users: [] });
      }`,
    });

    const result = await analyzeFindingReachability('app/api/users/route.ts', 1, workDir);
    expect(result.theoreticalRisk).toBe(false);
    expect(result.entryPointPath).toBe('Next.js API route');
  });

  it('detects CLI shebang entry point', async () => {
    const { analyzeFindingReachability } = await import('../src/utils/reachability.js');
    mockFiles({
      '/repo/src/cli.ts': `#!/usr/bin/env node
      import { main } from './app.js';
      main();`,
    });

    const result = await analyzeFindingReachability('src/cli.ts', 2, workDir);
    expect(result.theoreticalRisk).toBe(false);
    expect(result.entryPointPath).toBe('Shebang script');
  });
});

describe('analyzeBatchReachability', () => {
  const workDir = '/repo';

  beforeEach(() => {
    vi.clearAllMocks();
    mockNoFiles();
  });

  it('returns results aligned with input findings', async () => {
    mockFiles({
      '/repo/src/routes/api.ts': 'router.get("/", (req, res) => {});',
      '/repo/src/utils/helper.ts': 'export function helper() {}',
    });

    const results = await analyzeBatchReachability(
      [
        { file: 'src/routes/api.ts', line: 1 },
        { file: 'src/utils/helper.ts', line: 5 },
        { file: 'src/nonexistent.ts', line: 10 },
      ],
      workDir,
    );

    expect(results).toHaveLength(3);
    expect(results[0].theoreticalRisk).toBe(false);
    expect(results[0].entryPointPath).toBe('Express Router handler');
    expect(results[1].theoreticalRisk).toBe(true);
    expect(results[2].theoreticalRisk).toBe(true);
  });

  it('isolates per-item errors and returns theoreticalRisk=true for failed items', async () => {
    const results = await analyzeBatchReachability(
      [
        { file: 'src/a.ts', line: 1 },
        { file: 'src/b.ts', line: 2 },
      ],
      workDir,
    );

    expect(results).toHaveLength(2);
    expect(results[0].theoreticalRisk).toBe(true);
    expect(results[1].theoreticalRisk).toBe(true);
  });
});
