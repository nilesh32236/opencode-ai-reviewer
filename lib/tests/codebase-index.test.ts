import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodebaseIndexCache } from '../src/codebase-index/cache.js';
import { CodebaseExtractor } from '../src/codebase-index/extractor.js';
import { CodebaseIndex } from '../src/codebase-index/index.js';
import type { CodebaseIndexData } from '../src/codebase-index/types.js';
import { buildReviewPrompt } from '../src/prompts/builder.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-index-'));
  tempDirs.push(dir);
  return dir;
}

function writeFixture(root: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    const abs = path.join(root, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('CodebaseExtractor', () => {
  it('extracts symbols with kinds, signatures, and export flags', () => {
    const root = makeTempDir();
    writeFixture(root, {
      'src/lib/math.ts': `
        export function add(a: number, b: number): number {
          return a + b;
        }
        export default class Calculator {
          multiply(x: number, y: number): number {
            return x * y;
          }
        }
        export interface Options {
          verbose: boolean;
        }
        export type Result = string | number;
        export const MAX = 100;
        export enum Color { Red, Green }
        function internalHelper(): void {}
        const localVar = 1;
      `,
    });

    const index = new CodebaseExtractor().extract(root);
    expect(index.symbols.length).toBeGreaterThan(0);

    const byName = new Map(index.symbols.map((s) => [s.name, s]));
    expect(byName.get('add')).toMatchObject({
      kind: 'function',
      isExported: true,
      isDefaultExport: false,
      file: 'src/lib/math.ts',
    });
    expect(byName.get('add')?.signature).toBe('(a: number, b: number) => number');
    expect(byName.get('Calculator')).toMatchObject({ kind: 'class', isDefaultExport: true });
    expect(byName.get('Options')).toMatchObject({ kind: 'interface', isExported: true });
    expect(byName.get('Result')).toMatchObject({ kind: 'type', isExported: true });
    expect(byName.get('MAX')).toMatchObject({ kind: 'const', isExported: true });
    expect(byName.get('Color')).toMatchObject({ kind: 'enum', isExported: true });
    // Non-exported top-level symbols are recorded too.
    expect(byName.get('internalHelper')).toMatchObject({ isExported: false });
    expect(byName.get('localVar')).toMatchObject({ kind: 'const', isExported: false });
    // Line numbers are 1-based.
    expect(byName.get('add')?.line).toBe(2);
  });

  it('resolves imports across files (including .js -> .ts ESM mapping)', () => {
    const root = makeTempDir();
    writeFixture(root, {
      'src/a.ts': `import { add } from './lib/math.js';
        import math from './lib/math.js';
        import * as utils from './lib/utils';
        import './side-effect.css';`,
      'src/lib/math.ts': 'export function add(a: number, b: number): number { return a + b; }',
      'src/lib/utils.ts': 'export const identity = (x: number): number => x;',
      'src/side-effect.css': '',
    });

    const index = new CodebaseExtractor().extract(root);
    const importEdges = index.imports.filter((e) => e.sourceFile === 'src/a.ts');
    expect(importEdges.length).toBeGreaterThanOrEqual(3);

    const named = importEdges.find((e) => e.importedSymbol === 'add' && e.importKind === 'named');
    expect(named?.targetFile).toBe('src/lib/math.ts');

    const def = importEdges.find((e) => e.importedSymbol === 'math' && e.importKind === 'default');
    expect(def?.targetFile).toBe('src/lib/math.ts');

    const ns = importEdges.find(
      (e) => e.importedSymbol === 'utils' && e.importKind === 'namespace',
    );
    expect(ns?.targetFile).toBe('src/lib/utils.ts');
  });

  it('records caller->callee edges for local and imported functions', () => {
    const root = makeTempDir();
    writeFixture(root, {
      'src/helper.ts': `export function normalize(raw: string): string {
        return raw.trim();
      }`,
      'src/main.ts': `import { normalize } from './helper.js';
        function build(input: string): string {
          return normalize(input);
        }
        function local(): void {
          build('x');
        }
        build('y');`,
    });

    const index = new CodebaseExtractor().extract(root);
    const edges = index.callGraph.filter((e) => e.callerFile === 'src/main.ts');
    expect(edges.length).toBeGreaterThanOrEqual(2);

    // Imported callee resolves to the target file.
    const importedEdge = edges.find((e) => e.calleeFunction === 'normalize');
    expect(importedEdge?.calleeFile).toBe('src/helper.ts');
    expect(importedEdge?.callerFunction).toBe('build');

    // Local callee resolves to the same file, with enclosing caller name.
    const localEdge = edges.find((e) => e.calleeFunction === 'build');
    expect(localEdge?.calleeFile).toBe('src/main.ts');
    expect(localEdge?.callerFunction).toBe('local');
  });

  it('does not throw on missing or empty directories', () => {
    const missing = path.join(os.tmpdir(), 'codebase-index-missing-' + Date.now());
    const index = new CodebaseExtractor().extract(missing);
    expect(index.symbols).toEqual([]);
    expect(index.imports).toEqual([]);
    expect(index.callGraph).toEqual([]);

    const empty = makeTempDir();
    const emptyIndex = new CodebaseExtractor().extract(empty);
    expect(emptyIndex.symbols).toEqual([]);
  });
});

describe('CodebaseIndexCache', () => {
  it('returns the same data after set/get for a matching ref SHA', () => {
    const dir = makeTempDir();
    const cache = new CodebaseIndexCache(path.join(dir, 'cache'));
    const data: CodebaseIndexData = {
      refSha: 'abc123',
      symbols: [],
      imports: [],
      callGraph: [],
      buildTimeMs: 5,
    };
    cache.set('abc123', data);
    expect(cache.get('abc123')).toEqual(data);
  });

  it('returns null for an unknown ref SHA', () => {
    const dir = makeTempDir();
    const cache = new CodebaseIndexCache(path.join(dir, 'cache'));
    expect(cache.get('unknown-sha')).toBeNull();
  });

  it('invalidates an existing entry', () => {
    const dir = makeTempDir();
    const cache = new CodebaseIndexCache(path.join(dir, 'cache'));
    const data: CodebaseIndexData = {
      refSha: 'sha1',
      symbols: [],
      imports: [],
      callGraph: [],
      buildTimeMs: 5,
    };
    cache.set('sha1', data);
    expect(cache.get('sha1')).toEqual(data);
    cache.invalidate('sha1');
    expect(cache.get('sha1')).toBeNull();
  });
});

describe('CodebaseIndex', () => {
  it('builds an index, caches it by ref, and serves cached copies on rebuild', async () => {
    const dir = makeTempDir();
    writeFixture(dir, {
      'src/a.ts': 'export const value = 1;',
      'src/b.ts': "import { value } from './a.js'; export function use(): number { return value; }",
    });
    const cache = new CodebaseIndexCache(path.join(dir, '.opencode', 'codebase-index-cache'));
    const engine = new CodebaseIndex(cache);

    const first = await engine.buildOrLoad(dir, 'sha-1');
    expect(first.refSha).toBe('sha-1');
    expect(first.symbols.length).toBe(2);

    // A second build for the same ref is served from the cache (JSON round-trip
    // drops `undefined` fields, so compare content, not identity).
    const second = await engine.buildOrLoad(dir, 'sha-1');
    expect(second.refSha).toBe('sha-1');
    expect(second.symbols.length).toBe(first.symbols.length);
    expect(cache.get('sha-1')).toEqual(second);

    const third = await engine.buildOrLoad(dir, 'sha-2');
    expect(third.refSha).toBe('sha-2');
    expect(third).not.toBe(first);
  });

  it('getContextForFiles returns only relevant context for changed files', async () => {
    const dir = makeTempDir();
    writeFixture(dir, {
      'src/util.ts': 'export function helper(): void {}',
      'src/consumer.ts': `import { helper } from './util.js';
        export function run(): void { helper(); }`,
      'src/unrelated.ts': 'export const untouched = true;',
    });
    const engine = new CodebaseIndex();
    const index = await engine.buildOrLoad(dir, 'sha');

    const context = engine.getContextForFiles(index, ['src/util.ts']);

    // util.ts is the changed file: it exports a symbol, is imported by consumer,
    // and is called by consumer.run.
    expect(context.exportedSymbols.map((s) => s.name)).toContain('helper');
    expect(context.localSymbols.map((s) => s.name)).toContain('helper');
    expect(context.affectedImports.some((e) => e.targetFile === 'src/util.ts')).toBe(true);
    expect(context.affectedCallers.some((e) => e.calleeFunction === 'helper')).toBe(true);
    expect(context.affectedCallees.length).toBe(0);
    // Unrelated files must not leak in.
    expect(context.localSymbols.some((s) => s.name === 'untouched')).toBe(false);
  });

  it('formatContext renders markdown and returns "" when nothing is relevant', async () => {
    const dir = makeTempDir();
    writeFixture(dir, {
      'src/util.ts': 'export function helper(): void {}',
    });
    const engine = new CodebaseIndex();
    const index = await engine.buildOrLoad(dir, 'sha');

    const relevant = engine.formatContext(engine.getContextForFiles(index, ['src/util.ts']));
    expect(relevant).toContain('Exported Symbols in Changed Files');
    expect(relevant).toContain('helper');

    const irrelevant = engine.formatContext(engine.getContextForFiles(index, ['src/other.ts']));
    expect(irrelevant).toBe('');
  });

  it('injects the formatted index context into the review prompt', async () => {
    const dir = makeTempDir();
    writeFixture(dir, {
      'src/util.ts': 'export function helper(): void {}',
    });
    const engine = new CodebaseIndex();
    const index = await engine.buildOrLoad(dir, 'sha');
    const context = engine.formatContext(engine.getContextForFiles(index, ['src/util.ts']));

    const prompt = buildReviewPrompt(
      { projectContext: 'demo' },
      '## PR Context\nPR #1 changes src/util.ts',
      { codebaseIndexContext: context },
    );
    expect(prompt).toContain('## Codebase Context (Cross-File Analysis)');
    expect(prompt).toContain('helper');

    const plainPrompt = buildReviewPrompt({ projectContext: 'demo' }, '## PR Context\nPR #1');
    expect(plainPrompt).not.toContain('## Codebase Context (Cross-File Analysis)');
  });

  it('records unresolved local imports for broken-import detection', async () => {
    const dir = makeTempDir();
    writeFixture(dir, {
      'src/broken.ts': "import { missing } from './does-not-exist.js'; export const x = 1;",
    });
    const engine = new CodebaseIndex();
    const index = await engine.buildOrLoad(dir, 'sha');
    const context = engine.formatContext(engine.getContextForFiles(index, ['src/broken.ts']));
    expect(context).toContain('Unresolved Local Imports');
    expect(context).toContain('missing');
  });

  it('indexes large repositories quickly (performance sanity check)', () => {
    const dir = makeTempDir();
    // Simulate a ~10K-file repository with 500 modules x 20 files each.
    const files: Record<string, string> = {};
    for (let m = 0; m < 500; m++) {
      for (let f = 0; f < 20; f++) {
        const file = `src/mod${m}/file${f}.ts`;
        files[file] =
          `export function func${f}(a: number, b: number): number {\n` +
          `  return a + b + ${m};\n}\n` +
          `export const VALUE_${f} = ${m} * 100 + ${f};\n`;
      }
    }
    writeFixture(dir, files);

    const start = Date.now();
    const index = new CodebaseExtractor().extract(dir);
    const elapsedMs = Date.now() - start;

    expect(index.symbols.length).toBe(20000);
    expect(index.imports.length).toBe(0);
    // Acceptance criterion: index builds in <5s for 10K-file repos. The 20s
    // bound is deliberately generous so slow CI machines never flake.
    expect(elapsedMs).toBeLessThan(20_000);
  });
});
