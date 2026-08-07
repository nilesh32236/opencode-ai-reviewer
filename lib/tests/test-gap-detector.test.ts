import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, test } from 'vitest';
import type { ChangedFile } from '../src/types/index.js';
import {
  TestGapDetector,
  buildContextString,
  buildTestFileCandidates,
  extractExports,
  extractExportsFromContent,
  findTestFile,
  isTestFile,
  parsePatchTouchedNewLines,
  suggestTestPath,
} from '../src/utils/test-gap-detector.js';

const tempDirs: string[] = [];

function makeWorkDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'test-gap-'));
  tempDirs.push(dir);
  return dir;
}

function write(workDir: string, relPath: string, content: string): void {
  const full = path.join(workDir, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf-8');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SAMPLE_SOURCE = `
import { x } from './dep';

export function foo(a: number): number {
  if (a < 0) {
    throw new Error('negative');
  }
  return a * 2;
}

export async function bar(): Promise<void> {
  await x();
}

export class Widget {
  render(): string {
    return 'w';
  }
}

export const LIMIT = 100;

export interface Shape {
  area(): number;
}

export type Maybe<T> = T | null;

export default function root(): void {}
`;

describe('extractExports', () => {
  it('extracts function, class, const, default, interface, and type exports', () => {
    const dir = makeWorkDir();
    const file = path.join(dir, 'src', 'sample.ts');
    write(dir, 'src/sample.ts', SAMPLE_SOURCE);

    const symbols = extractExports(file);
    const names = symbols.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(['foo', 'bar', 'Widget', 'LIMIT', 'Shape', 'Maybe', 'root']),
    );

    const foo = symbols.find((s) => s.name === 'foo');
    expect(foo?.kind).toBe('function');
    expect(foo?.hasErrorHandling).toBe(true);
    const widget = symbols.find((s) => s.name === 'Widget');
    expect(widget?.kind).toBe('class');
    const limit = symbols.find((s) => s.name === 'LIMIT');
    expect(limit?.kind).toBe('const');
  });

  it('tracks the line range of a block-bodied function', () => {
    const symbols = extractExportsFromContent(SAMPLE_SOURCE, 'sample.ts');
    const foo = symbols.find((s) => s.name === 'foo');
    expect(foo).toBeDefined();
    expect(foo!.line).toBeLessThan(foo!.endLine);
  });

  it('handles re-exports from another module', () => {
    const content = `import { a } from './a';\nimport { b } from './b';\nexport { a as renamed, b } from './lib';\n`;
    const symbols = extractExportsFromContent(content, 'index.ts');
    const reexports = symbols.filter((s) => s.kind === 'reexport');
    expect(reexports.length).toBeGreaterThan(0);
    expect(reexports.some((s) => s.name === 'renamed')).toBe(true);
    expect(reexports.some((s) => s.name === 'b')).toBe(true);
  });

  it('ignores exports commented out', () => {
    const content = `// export function dead() {}\n/*\nexport function blocked() {}\n*/\nexport function live() {}\n`;
    const symbols = extractExportsFromContent(content, 'x.ts');
    expect(symbols.some((s) => s.name === 'dead')).toBe(false);
    expect(symbols.some((s) => s.name === 'blocked')).toBe(false);
    expect(symbols.some((s) => s.name === 'live')).toBe(true);
  });

  it('ignores exports commented out with a trailing same-line comment', () => {
    const content = `import { x } from './x';
live(); // export function dead() {}
export function live() {}
`;
    const symbols = extractExportsFromContent(content, 'x.ts');
    expect(symbols.some((s) => s.name === 'dead')).toBe(false);
    expect(symbols.some((s) => s.name === 'live')).toBe(true);
  });

  it('consistently detects error handling across consecutive symbols', () => {
    const content = [
      'export function a() { throw new Error("a"); }',
      'export function b() { throw new Error("b"); }',
      'export function c() { throw new Error("c"); }',
      '',
    ].join('\n');
    const symbols = extractExportsFromContent(content, 'x.ts');
    const flagged = symbols.filter((s) => s.hasErrorHandling).map((s) => s.name);
    expect(flagged).toEqual(['a', 'b', 'c']);
  });

  it('does not treat bare Error construction as an unhandled error path', () => {
    const content = 'export function a() { const e = new Error("x"); return e.message; }\n';
    const symbols = extractExportsFromContent(content, 'x.ts');
    expect(symbols[0].hasErrorHandling).toBe(false);
  });

  it('reports only the error paths actually present in a symbol body', () => {
    const content = [
      'export function throwsOne() { throw new Error("x"); }',
      'export function rejectsOne() { return Promise.reject(new Error("x")); }',
      '',
    ].join('\n');
    const symbols = extractExportsFromContent(content, 'x.ts');
    const throwsOne = symbols.find((s) => s.name === 'throwsOne');
    expect(throwsOne?.errorPaths).toEqual(['throw']);
    const rejectsOne = symbols.find((s) => s.name === 'rejectsOne');
    expect(rejectsOne?.errorPaths).toEqual(['reject']);
  });

  it('preserves the provided relative path in SourceSymbol.file', () => {
    const dir = makeWorkDir();
    write(dir, 'pkg/src/mod.ts', 'export function foo() {}\n');
    const symbols = extractExports(path.join(dir, 'pkg', 'src', 'mod.ts'), 'pkg/src/mod.ts');
    expect(symbols[0].file).toBe('pkg/src/mod.ts');
  });
});

describe('isTestFile', () => {
  it('recognizes .test and .spec conventions and __tests__ directories', () => {
    expect(isTestFile('src/foo.test.ts')).toBe(true);
    expect(isTestFile('src/foo.spec.js')).toBe(true);
    expect(isTestFile('src/__tests__/foo.ts')).toBe(true);
    expect(isTestFile('src/foo.ts')).toBe(false);
  });
});

describe('findTestFile', () => {
  it('maps src/foo.ts to src/foo.test.ts', () => {
    const dir = makeWorkDir();
    write(dir, 'src/foo.ts', 'export const foo = 1;');
    write(dir, 'src/foo.test.ts', 'import { foo } from "./foo";');
    expect(findTestFile('src/foo.ts', dir)).toBe('src/foo.test.ts');
  });

  it('maps src/foo.ts to src/__tests__/foo.test.ts when present', () => {
    const dir = makeWorkDir();
    write(dir, 'src/foo.ts', 'export const foo = 1;');
    write(dir, 'src/__tests__/foo.test.ts', 'import { foo } from "../foo";');
    expect(findTestFile('src/foo.ts', dir)).toBe('src/__tests__/foo.test.ts');
  });

  it('maps src/foo.ts to tests/foo.test.ts root mirror', () => {
    const dir = makeWorkDir();
    write(dir, 'src/foo.ts', 'export const foo = 1;');
    write(dir, 'tests/foo.test.ts', 'import { foo } from "../src/foo";');
    expect(findTestFile('src/foo.ts', dir)).toBe('tests/foo.test.ts');
  });

  it('maps lib/src/foo.ts to lib/tests/foo.test.ts monorepo mirror', () => {
    const dir = makeWorkDir();
    write(dir, 'lib/src/foo.ts', 'export const foo = 1;');
    write(dir, 'lib/tests/foo.test.ts', 'import { foo } from "../src/foo";');
    expect(findTestFile('lib/src/foo.ts', dir)).toBe('lib/tests/foo.test.ts');
  });

  it('maps src/sub/foo.ts to tests/sub/foo.test.ts preserving subdirectories', () => {
    const dir = makeWorkDir();
    write(dir, 'src/sub/foo.ts', 'export const foo = 1;');
    write(dir, 'tests/sub/foo.test.ts', 'import { foo } from "../../src/sub/foo";');
    expect(findTestFile('src/sub/foo.ts', dir)).toBe('tests/sub/foo.test.ts');
  });

  it('returns null when no convention-matching file exists', () => {
    const dir = makeWorkDir();
    write(dir, 'src/foo.ts', 'export const foo = 1;');
    expect(findTestFile('src/foo.ts', dir)).toBeNull();
  });

  it('builds the full candidate list in priority order', () => {
    const candidates = buildTestFileCandidates('src/foo.ts');
    expect(candidates[0]).toBe('src/foo.test.ts');
    expect(candidates).toEqual(expect.arrayContaining(['src/__tests__/foo.test.ts']));
    expect(candidates).toEqual(expect.arrayContaining(['tests/foo.test.ts']));
  });

  it('suggests the primary co-located test path even when it does not exist', () => {
    expect(suggestTestPath('src/foo.ts')).toBe('src/foo.test.ts');
  });
});

describe('parsePatchTouchedNewLines', () => {
  it('extracts new-file line numbers of added lines touched by a diff', () => {
    const patch = [
      '@@ -1,3 +1,5 @@',
      ' export function foo() {',
      '+  console.log("new");',
      '   return 1;',
      '-}',
      '+}',
      '',
    ].join('\n');
    const touched = parsePatchTouchedNewLines(patch);
    // Only added ('+') lines are recorded; unchanged context lines (' ') keep
    // the line counter moving but do NOT mark neighbouring symbols as touched.
    expect(touched.has(2)).toBe(true);
    expect(touched.has(4)).toBe(true);
    expect(touched.has(3)).toBe(false);
    expect(touched.has(1)).toBe(false);
  });

  it('returns an empty set for missing patches', () => {
    expect(parsePatchTouchedNewLines(undefined).size).toBe(0);
  });
});

describe('TestGapDetector', () => {
  it('detects modified symbols whose test file was NOT updated', () => {
    const dir = makeWorkDir();
    write(dir, 'src/foo.ts', 'export function foo() { return 1; }');
    write(dir, 'src/foo.test.ts', 'test("foo", () => { expect(foo()).toBe(1); });');

    const changedFiles: ChangedFile[] = [
      {
        path: 'src/foo.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        patch:
          '@@ -1 +1 @@\n-export function foo() { return 1; }\n+export function foo() { return 2; }\n',
      },
    ];

    const detector = new TestGapDetector();
    const result = detector.analyze(changedFiles, dir);
    expect(result.modifiedUnchangedTests).toHaveLength(1);
    expect(result.modifiedUnchangedTests[0].sourceFile).toBe('src/foo.ts');
    expect(result.modifiedUnchangedTests[0].symbolName).toBe('foo');
    expect(result.modifiedUnchangedTests[0].testFile).toBe('src/foo.test.ts');
  });

  it('does NOT flag when the test file was also modified', () => {
    const dir = makeWorkDir();
    write(dir, 'src/foo.ts', 'export function foo() { return 2; }');
    write(dir, 'src/foo.test.ts', 'test("foo", () => { expect(foo()).toBe(2); });');

    const changedFiles: ChangedFile[] = [
      {
        path: 'src/foo.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        patch:
          '@@ -1 +1 @@\n-export function foo() { return 1; }\n+export function foo() { return 2; }\n',
      },
      {
        path: 'src/foo.test.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        patch:
          '@@ -1 +1 @@\n-test("foo", () => { expect(foo()).toBe(1); });\n+test("foo", () => { expect(foo()).toBe(2); });\n',
      },
    ];

    const detector = new TestGapDetector();
    const result = detector.analyze(changedFiles, dir);
    expect(result.modifiedUnchangedTests).toHaveLength(0);
  });

  it('detects a brand-new export without any test file', () => {
    const dir = makeWorkDir();
    write(dir, 'src/newmod.ts', 'export function newThing() { return 1; }');

    const changedFiles: ChangedFile[] = [
      { path: 'src/newmod.ts', status: 'added', additions: 5, deletions: 0 },
    ];

    const detector = new TestGapDetector();
    const result = detector.analyze(changedFiles, dir);
    expect(result.newUntestedExports).toHaveLength(1);
    expect(result.newUntestedExports[0].symbolName).toBe('newThing');
  });

  it('does NOT flag a new export whose test file exists and was modified', () => {
    const dir = makeWorkDir();
    write(dir, 'src/newmod.ts', 'export function newThing() { return 1; }');
    write(dir, 'src/newmod.test.ts', 'test("newThing", () => { expect(newThing()).toBe(1); });');

    const changedFiles: ChangedFile[] = [
      { path: 'src/newmod.ts', status: 'added', additions: 5, deletions: 0 },
      { path: 'src/newmod.test.ts', status: 'added', additions: 3, deletions: 0 },
    ];

    const detector = new TestGapDetector();
    const result = detector.analyze(changedFiles, dir);
    expect(result.newUntestedExports).toHaveLength(0);
  });

  it('flags error-handling paths without error-case tests', () => {
    const dir = makeWorkDir();
    write(
      dir,
      'src/err.ts',
      `export function risky() {
  if (Math.random() > 0.5) {
    throw new Error('boom');
  }
  return 'ok';
}
`,
    );
    write(
      dir,
      'src/err.test.ts',
      'test("risky happy path", () => { expect(risky()).toBe("ok"); });',
    );

    const changedFiles: ChangedFile[] = [
      {
        path: 'src/err.ts',
        status: 'modified',
        additions: 3,
        deletions: 1,
        patch:
          "@@ -1,5 +1,6 @@\n export function risky() {\n+  if (Math.random() > 0.5) {\n+    throw new Error('boom');\n+  }\n   return 'ok';\n }\n",
      },
    ];

    const detector = new TestGapDetector();
    const result = detector.analyze(changedFiles, dir);
    const errorGap = result.missingErrorCaseTests.find((g) => g.symbolName === 'risky');
    expect(errorGap).toBeDefined();
    expect(errorGap?.testFile).toBe('src/err.test.ts');
  });

  it('does NOT flag error handling when the test asserts rejections', () => {
    const dir = makeWorkDir();
    write(
      dir,
      'src/err2.ts',
      `export async function riskyAsync() {
  if (Math.random() > 0.5) {
    throw new Error('boom');
  }
  return 'ok';
}
`,
    );
    write(
      dir,
      'src/err2.test.ts',
      'test("rejects", async () => { await expect(riskyAsync()).rejects.toThrow("boom"); });',
    );

    const changedFiles: ChangedFile[] = [
      { path: 'src/err2.ts', status: 'added', additions: 8, deletions: 0 },
      { path: 'src/err2.test.ts', status: 'added', additions: 3, deletions: 0 },
    ];

    const detector = new TestGapDetector();
    const result = detector.analyze(changedFiles, dir);
    expect(result.missingErrorCaseTests).toHaveLength(0);
  });

  it('does NOT flag type-only exports as untested', () => {
    const dir = makeWorkDir();
    write(
      dir,
      'src/types.ts',
      'export interface Shape { area(): number; }\nexport type Maybe<T> = T | null;\n',
    );

    const changedFiles: ChangedFile[] = [
      { path: 'src/types.ts', status: 'added', additions: 2, deletions: 0 },
    ];

    const detector = new TestGapDetector();
    const result = detector.analyze(changedFiles, dir);
    expect(result.newUntestedExports).toHaveLength(0);
  });

  it('does NOT flag modified type-only exports without test updates', () => {
    const dir = makeWorkDir();
    write(
      dir,
      'src/types.ts',
      'export interface Shape { area(): number; }\nexport type Maybe<T> = T | null;\n',
    );

    const changedFiles: ChangedFile[] = [
      {
        path: 'src/types.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        patch:
          '@@ -1 +1 @@\n-export interface Shape { area(): number; }\n+export interface Shape { perimeter(): number; }\n',
      },
    ];

    const detector = new TestGapDetector();
    const result = detector.analyze(changedFiles, dir);
    expect(result.modifiedUnchangedTests).toHaveLength(0);
  });

  it('falls back to the previous git revision when no patch is present', () => {
    const dir = makeWorkDir();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    write(dir, 'src/svc.ts', 'export function alpha() { return 1; }\n');
    write(dir, 'src/svc.test.ts', 'test("alpha", () => {});');
    git('add', '.');
    git('commit', '-qm', 'init');

    // Insert a line above `alpha` so its line number shifts; the no-patch
    // fallback must still match `alpha` by name, not by stale line number.
    write(dir, 'src/svc.ts', '// header\nexport function alpha() { return 2; }\n');

    const detector = new TestGapDetector();
    const result = detector.analyze(
      [{ path: 'src/svc.ts', status: 'modified', additions: 2, deletions: 1 }],
      dir,
    );

    expect(result.newUntestedExports).toHaveLength(0);
    expect(result.modifiedUnchangedTests.some((g) => g.symbolName === 'alpha')).toBe(true);
  });
});

describe('buildContextString', () => {
  it('generates non-empty markdown when gaps exist', () => {
    const result = buildContextString({
      modifiedUnchangedTests: [
        {
          sourceFile: 'src/foo.ts',
          symbolName: 'foo',
          testFile: 'src/foo.test.ts',
          reason: 'modified without test update',
        },
      ],
      newUntestedExports: [],
      missingErrorCaseTests: [],
      testSuggestions: [],
      contextString: '',
    });
    expect(result).toContain('Modified without test updates');
    expect(result).toContain('src/foo.ts');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns empty string when no gaps are found', () => {
    const result = buildContextString({
      modifiedUnchangedTests: [],
      newUntestedExports: [],
      missingErrorCaseTests: [],
      testSuggestions: [],
      contextString: '',
    });
    expect(result).toBe('');
  });
});

describe('TestGapDetector.analyze integration', () => {
  it('returns expected results for a realistic file set', () => {
    const dir = makeWorkDir();
    write(
      dir,
      'src/payment.ts',
      `export function charge(amount: number): string {
  if (amount <= 0) {
    throw new Error('invalid amount');
  }
  return 'charged';
}

export function refund(id: string): string {
  return 'refunded ' + id;
}
`,
    );
    write(
      dir,
      'src/payment.test.ts',
      'test("charge", () => { expect(charge(10)).toBe("charged"); });\ntest("refund", () => { expect(refund("1")).toBe("refunded 1"); });',
    );
    write(dir, 'src/invoice.ts', 'export function issueInvoice() { return "issued"; }');

    const changedFiles: ChangedFile[] = [
      {
        path: 'src/payment.ts',
        status: 'modified',
        additions: 5,
        deletions: 1,
        patch:
          "@@ -1,7 +1,11 @@\n export function charge(amount: number): string {\n+  if (amount <= 0) {\n+    throw new Error('invalid amount');\n+  }\n   return 'charged';\n }\n \n export function refund(id: string): string {\n+  return 'refunded ' + id;\n }\n",
      },
      { path: 'src/invoice.ts', status: 'added', additions: 2, deletions: 0 },
    ];

    const detector = new TestGapDetector();
    const result = detector.analyze(changedFiles, dir);

    // `payment.ts` was modified but its test file was NOT part of this PR.
    expect(result.modifiedUnchangedTests.some((g) => g.symbolName === 'charge')).toBe(true);
    expect(result.modifiedUnchangedTests.some((g) => g.symbolName === 'refund')).toBe(true);
    // `payment.ts` has error handling (throw) but its unchanged test lacks error assertions.
    expect(result.missingErrorCaseTests.some((g) => g.symbolName === 'charge')).toBe(true);
    // `invoice.ts` is brand new with no test file.
    expect(result.newUntestedExports.some((g) => g.symbolName === 'issueInvoice')).toBe(true);
    // Suggestions mirror the gaps.
    expect(result.testSuggestions.length).toBeGreaterThanOrEqual(3);
    // Context string is populated.
    expect(result.contextString.length).toBeGreaterThan(0);
    expect(result.contextString).toContain('charge');
  });

  it('produces empty context when a fully-tested change ships', () => {
    const dir = makeWorkDir();
    write(dir, 'src/util.ts', 'export function add(a: number, b: number) { return a + b; }');
    write(
      dir,
      'src/util.test.ts',
      'test("add", () => { expect(add(1, 2)).toBe(3); });\nimport { add } from "./util";',
    );

    const changedFiles: ChangedFile[] = [
      {
        path: 'src/util.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        patch:
          '@@ -1 +1 @@\n-export function add(a: number, b: number) { return a + b; }\n+export function add(a: number, b: number) { return a + b + 0; }\n',
      },
      {
        path: 'src/util.test.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        patch:
          '@@ -1 +1 @@\n-test("add", () => { expect(add(1, 2)).toBe(3); });\n+test("add", () => { expect(add(1, 2)).toBe(3); });\n',
      },
    ];

    const detector = new TestGapDetector();
    const result = detector.analyze(changedFiles, dir);
    expect(result.modifiedUnchangedTests).toHaveLength(0);
    expect(result.newUntestedExports).toHaveLength(0);
    expect(result.contextString).toBe('');
  });
});
