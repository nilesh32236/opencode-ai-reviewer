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

  it('rejects entries with array-shaped but structurally invalid contents', () => {
    const dir = makeTempDir();
    const cacheDir = path.join(dir, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const cache = new CodebaseIndexCache(cacheDir);

    fs.writeFileSync(
      path.join(cacheDir, 'bad-symbol.json'),
      JSON.stringify({
        refSha: 'bad-symbol',
        symbols: [{ name: 42 }],
        imports: [],
        callGraph: [],
      }),
      'utf-8',
    );
    expect(cache.get('bad-symbol')).toBeNull();

    fs.writeFileSync(
      path.join(cacheDir, 'bad-import.json'),
      JSON.stringify({
        refSha: 'bad-import',
        symbols: [],
        imports: [{ sourceFile: 42 }],
        callGraph: [],
      }),
      'utf-8',
    );
    expect(cache.get('bad-import')).toBeNull();

    fs.writeFileSync(
      path.join(cacheDir, 'bad-call.json'),
      JSON.stringify({
        refSha: 'bad-call',
        symbols: [],
        imports: [],
        callGraph: [{ callerFile: 42 }],
      }),
      'utf-8',
    );
    expect(cache.get('bad-call')).toBeNull();
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
    // A distinct ref produces a distinct cache entry rather than reusing sha-1.
    expect(cache.get('sha-2')?.refSha).toBe('sha-2');
    expect(cache.get('sha-1')?.refSha).toBe('sha-1');
    expect(third.symbols.length).toBe(first.symbols.length);
  });

  it('rejects corrupt cache entries and degrades to a rebuild', async () => {
    const dir = makeTempDir();
    const cacheDir = path.join(dir, '.opencode', 'codebase-index-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const cache = new CodebaseIndexCache(cacheDir);
    const engine = new CodebaseIndex(cache);

    // Corrupt JSON in the cache directory is ignored.
    fs.writeFileSync(path.join(cacheDir, 'corrupt-sha.json'), '{not-valid-json', 'utf-8');
    expect(cache.get('corrupt-sha')).toBeNull();

    // A refSha mismatch is rejected.
    fs.writeFileSync(
      path.join(cacheDir, 'mismatch-sha.json'),
      JSON.stringify({ refSha: 'other-sha', symbols: [], imports: [], callGraph: [] }),
      'utf-8',
    );
    expect(cache.get('mismatch-sha')).toBeNull();

    // Missing/partial collections (e.g. no callGraph) are rejected.
    fs.writeFileSync(
      path.join(cacheDir, 'partial-sha.json'),
      JSON.stringify({ refSha: 'partial-sha', symbols: [], imports: [] }),
      'utf-8',
    );
    expect(cache.get('partial-sha')).toBeNull();

    // A valid entry survives and is served by buildOrLoad.
    writeFixture(dir, { 'src/a.ts': 'export const value = 1;' });
    const built = await engine.buildOrLoad(dir, 'valid-sha');
    expect(built.symbols.length).toBe(1);
    expect(cache.get('valid-sha')?.refSha).toBe('valid-sha');
  });

  it('records external package imports without flagging them as broken local imports', async () => {
    const dir = makeTempDir();
    writeFixture(dir, {
      'src/a.ts': `import { z } from 'zod';
        import * as fs from 'fs';
        import { missing } from './does-not-exist.js';
        export const x = 1;`,
    });
    const engine = new CodebaseIndex();
    const index = await engine.buildOrLoad(dir, 'sha');
    const context = engine.formatContext(engine.getContextForFiles(index, ['src/a.ts']));

    // External/bare specifiers are marked external and never rendered as broken.
    expect(index.imports.some((e) => e.isExternal && e.importedSymbol === 'z')).toBe(true);
    expect(index.imports.some((e) => e.isExternal && e.importedSymbol === 'fs')).toBe(true);
    expect(context).toContain('Unresolved Local Imports');
    expect(context).toContain('missing');
    expect(context).not.toContain('zod');
  });

  it('does not flag non-code asset imports as broken local imports', async () => {
    const dir = makeTempDir();
    writeFixture(dir, {
      'src/main.ts': `import './styles.css';
        import data from './data.json';
        import { missing } from './does-not-exist.js';
        export const x = 1;`,
    });
    const engine = new CodebaseIndex();
    const index = await engine.buildOrLoad(dir, 'sha');
    const context = engine.formatContext(engine.getContextForFiles(index, ['src/main.ts']));

    expect(context).toContain('Unresolved Local Imports');
    expect(context).toContain('missing');
    expect(context).not.toContain('styles.css');
    expect(context).not.toContain('data.json');
  });

  it('does not flag query-string/fragment asset imports as broken local imports', async () => {
    const dir = makeTempDir();
    writeFixture(dir, {
      'src/main.ts': `import './styles.css?inline';
        import icon from './icon.svg?url';
        import data from './data.json?raw';
        import { missing } from './does-not-exist.js';
        export const x = 1;`,
    });
    const engine = new CodebaseIndex();
    const index = await engine.buildOrLoad(dir, 'sha');
    const context = engine.formatContext(engine.getContextForFiles(index, ['src/main.ts']));

    expect(context).toContain('Unresolved Local Imports');
    expect(context).toContain('missing');
    expect(context).not.toContain('styles.css');
    expect(context).not.toContain('icon.svg');
    expect(context).not.toContain('data.json');
  });

  it('does not extract phantom symbols from non-module exports assignments', async () => {
    const dir = makeTempDir();
    writeFixture(dir, {
      'src/main.js': `const obj = {};
        obj.exports = 2;
        const fooexports = {};
        fooexports.bar = 3;
        module.exports = { real: true };
        exports.extra = 1;`,
    });
    const engine = new CodebaseIndex();
    const index = await engine.buildOrLoad(dir, 'sha');

    const exported = index.symbols.filter((s) => s.file === 'src/main.js' && s.isExported);
    expect(exported.map((s) => s.name)).toEqual(['default', 'extra']);
  });

  it('extracts CommonJS module.exports symbols from TypeScript files', async () => {
    const dir = makeTempDir();
    writeFixture(dir, {
      'src/helper.ts': 'export function helper(): void {}',
      'src/main.ts': `import { helper } from './helper.js';
        const { extra } = require('./helper.js');
        module.exports = { helper };`,
    });
    const engine = new CodebaseIndex();
    const index = await engine.buildOrLoad(dir, 'sha');

    const exported = index.symbols.filter((s) => s.file === 'src/main.ts' && s.isExported);
    expect(exported.some((s) => s.name === 'default')).toBe(true);
  });

  it('records <default> for default-import call edges instead of the local alias', async () => {
    const dir = makeTempDir();
    writeFixture(dir, {
      'src/impl.ts': 'export function main(): void {}',
      'src/caller.ts': `import build from './impl.js';
        export function run(): void { build(); }`,
    });
    const engine = new CodebaseIndex();
    const index = await engine.buildOrLoad(dir, 'sha');

    const edge = index.callGraph.find(
      (e) => e.callerFile === 'src/caller.ts' && e.calleeFile === 'src/impl.ts',
    );
    expect(edge?.calleeFunction).toBe('<default>');
  });

  it('indexes anonymous default exports', async () => {
    const dir = makeTempDir();
    writeFixture(dir, {
      'src/a.ts': 'export default function () {}',
      'src/b.ts': 'export default class {}',
      'src/c.tsx': 'export default () => 42;',
    });
    const engine = new CodebaseIndex();
    const index = await engine.buildOrLoad(dir, 'sha');

    const defaults = index.symbols.filter((s) => s.name === 'default' && s.isDefaultExport);
    expect(defaults.some((s) => s.file === 'src/a.ts' && s.kind === 'function')).toBe(true);
    expect(defaults.some((s) => s.file === 'src/b.ts' && s.kind === 'class')).toBe(true);
    expect(defaults.some((s) => s.file === 'src/c.tsx' && s.kind === 'function')).toBe(true);
  });

  it('excludes intra-file call edges from cross-file caller/callee sections', async () => {
    const dir = makeTempDir();
    writeFixture(dir, {
      'src/main.ts': `function local(): void {}
        export function run(): void { local(); }`,
      'src/other.ts': 'export const x = 1;',
    });
    const engine = new CodebaseIndex();
    const index = await engine.buildOrLoad(dir, 'sha');

    const context = engine.getContextForFiles(index, ['src/main.ts']);
    // local() is called from run() within the same file — not a cross-file edge.
    expect(context.affectedCallers.length).toBe(0);
    expect(context.affectedCallees.length).toBe(0);
  });

  it('surfaces matching workspace packages in the formatted context', async () => {
    const dir = makeTempDir();
    writeFixture(dir, {
      'package.json': JSON.stringify({ name: 'my-monorepo', workspaces: ['packages/*'] }),
      'packages/core/src/index.ts': 'export const value = 1;',
      'packages/app/src/index.ts': 'export const appValue = 2;',
    });
    const engine = new CodebaseIndex();
    const index = await engine.buildOrLoad(dir, 'sha');

    const context = engine.formatContext(
      engine.getContextForFiles(index, ['packages/core/src/index.ts']),
    );
    expect(context).toContain('Workspace Packages');
    expect(context).toContain('packages/*');

    // A file outside any workspace package produces no workspace section.
    const plain = engine.formatContext(engine.getContextForFiles(index, ['src/root.ts']));
    expect(plain).not.toContain('Workspace Packages');
  });

  it('extracts require() and dynamic import() edges from TypeScript files too', async () => {
    const dir = makeTempDir();
    writeFixture(dir, {
      'src/mod.ts': 'export function helper(): void {}',
      'src/main.ts': `import { helper } from './mod.js';
        const viaRequire = require('./mod.js');
        export async function run(): Promise<void> {
          await import('./mod.js');
          helper();
        }`,
    });
    const engine = new CodebaseIndex();
    const index = await engine.buildOrLoad(dir, 'sha');

    // The static import is an AST edge; require() and dynamic import() are
    // regex edges (deduped to one) — all resolve to the same module.
    const toMod = index.imports.filter(
      (e) => e.sourceFile === 'src/main.ts' && e.targetFile === 'src/mod.ts',
    );
    expect(toMod.length).toBeGreaterThanOrEqual(2);
  });

  it('dedupes require() against a static side-effect import in the same .js file', async () => {
    const dir = makeTempDir();
    writeFixture(dir, {
      'src/helper.js': 'function helper() { return 1; }\nmodule.exports = helper;',
      'src/main.js': `import './helper.js';
        require('./helper.js');`,
    });
    const engine = new CodebaseIndex();
    const index = await engine.buildOrLoad(dir, 'sha');

    const toHelper = index.imports.filter(
      (e) => e.sourceFile === 'src/main.js' && e.targetFile === 'src/helper.js',
    );
    expect(toHelper.length).toBe(1);
  });

  it('ignores require()/module.exports text inside comments and strings', async () => {
    const dir = makeTempDir();
    writeFixture(dir, {
      'src/real.js': 'module.exports = { real: true };',
      'src/main.cjs': `// require('./ghost.js')
        const text = "module.exports = 'fake'";
        require('./real.js');
        module.exports = { real: true };`,
    });
    const engine = new CodebaseIndex();
    const index = await engine.buildOrLoad(dir, 'sha');

    const targets = index.imports
      .filter((e) => e.sourceFile === 'src/main.cjs')
      .map((e) => e.targetFile);
    expect(targets).toContain('src/real.js');
    expect(targets).not.toContain('src/ghost.js');

    const exportedNames = index.symbols
      .filter((s) => s.file === 'src/main.cjs' && s.isExported)
      .map((s) => s.name);
    expect(exportedNames).toEqual(['default']);
  });

  it('extracts CommonJS require() and module.exports via the regex pass on .js/.cjs files', () => {
    const root = makeTempDir();
    writeFixture(root, {
      'src/legacy.cjs': `const { helper } = require('./helper.js');
        module.exports = { run: helper };
        exports.extra = 1;`,
      'src/helper.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
    });

    const index = new CodebaseExtractor().extract(root);
    const cjsImports = index.imports.filter((e) => e.sourceFile === 'src/legacy.cjs');
    // require('./helper.js') is captured even though the AST parse succeeds.
    expect(cjsImports.some((e) => e.targetFile === 'src/helper.js')).toBe(true);

    // module.exports / exports.extra symbols are recorded as exported.
    const exported = index.symbols.filter((s) => s.file === 'src/legacy.cjs' && s.isExported);
    expect(exported.some((s) => s.name === 'default')).toBe(true);
    expect(exported.some((s) => s.name === 'extra')).toBe(true);
  });

  it('resolves namespace-import member calls but not arbitrary receiver properties', async () => {
    const dir = makeTempDir();
    writeFixture(dir, {
      'src/utils.ts': 'export function normalize(raw: string): string { return raw.trim(); }',
      'src/main.ts': `import * as utils from './utils.js';
        class Logger {
          log(message: string): void { console.log(message); }
        }
        export function run(): void {
          utils.normalize(' x ');
          new Logger().log('world');
        }`,
    });
    const engine = new CodebaseIndex();
    const index = await engine.buildOrLoad(dir, 'sha');

    // utils.normalize() resolves through the namespace import.
    const memberEdge = index.callGraph.find((e) => e.calleeFunction === 'normalize');
    expect(memberEdge?.calleeFile).toBe('src/utils.ts');

    // console.log() and Logger().log() never resolve to local symbols.
    const logEdges = index.callGraph.filter((e) => e.calleeFunction === 'log');
    expect(logEdges.length).toBe(0);
  });

  it('indexes export default identifiers and local re-exports', async () => {
    const dir = makeTempDir();
    writeFixture(dir, {
      'src/main.ts': `function engine(): void {}
        export default engine;
        export { engine as engineAlias };
        export const visible = true;`,
    });
    const engine = new CodebaseIndex();
    const index = await engine.buildOrLoad(dir, 'sha');

    const engineSymbol = index.symbols.find((s) => s.name === 'engine');
    expect(engineSymbol?.isDefaultExport).toBe(true);
    expect(engineSymbol?.isExported).toBe(true);

    // `export { engine as engineAlias }` without a `from` clause records a
    // local re-export edge back to the same file.
    expect(
      index.imports.some(
        (e) =>
          e.sourceFile === 'src/main.ts' &&
          e.targetFile === 'src/main.ts' &&
          e.importedSymbol === 'engineAlias',
      ),
    ).toBe(true);
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
    // Simulate a ~10K-file repository with 500 modules x 20 files each. Every
    // file imports a sibling, so the hot `resolveLocalImport` path (up to ~20
    // filesystem probes per specifier) is exercised and measured.
    const files: Record<string, string> = {};
    for (let m = 0; m < 500; m++) {
      for (let f = 0; f < 20; f++) {
        const file = `src/mod${m}/file${f}.ts`;
        files[file] =
          `import { func0 } from './file0.js';\n` +
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
    expect(index.imports.length).toBeGreaterThan(0);
    // Acceptance criterion: index builds in <5s for 10K-file repos. The 20s
    // bound is deliberately generous so slow CI machines never flake.
    // eslint-disable-next-line no-console
    console.log(`10K-file index built in ${elapsedMs}ms (target: <5000ms)`);
    expect(elapsedMs).toBeLessThan(20_000);
  });
});
