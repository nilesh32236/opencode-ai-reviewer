import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  type ExtractOptions,
  detectLockFileType,
  extractChangedDependencies,
  parsePatchLines,
} from '../../src/sca/lockfile.js';
import type { ChangedFile } from '../../src/types/index.js';
import { DEFAULT_SCA_LOCK_FILE_PATTERNS, type SCADependency } from '../../src/types/index.js';

function changedFile(path: string, patch?: string): ChangedFile {
  return {
    path,
    status: 'modified',
    additions: 0,
    deletions: 0,
    ...(patch !== undefined ? { patch } : {}),
  };
}

function makeOptions(overrides: Partial<ExtractOptions> = {}): ExtractOptions {
  return {
    lockFilePatterns: DEFAULT_SCA_LOCK_FILE_PATTERNS,
    excludePatterns: [],
    ...overrides,
  };
}

function expectDep(deps: SCADependency[], name: string, version: string): void {
  const match = deps.find((d) => d.name === name);
  expect(match).toBeDefined();
  expect(match?.version).toBe(version);
}

describe('detectLockFileType', () => {
  it('detects all seven supported lock files', () => {
    expect(detectLockFileType('package-lock.json')).toEqual({
      type: 'package-lock.json',
      ecosystem: 'npm',
    });
    expect(detectLockFileType('yarn.lock')).toEqual({ type: 'yarn.lock', ecosystem: 'npm' });
    expect(detectLockFileType('pnpm-lock.yaml')).toEqual({
      type: 'pnpm-lock.yaml',
      ecosystem: 'npm',
    });
    expect(detectLockFileType('Cargo.lock')).toEqual({
      type: 'Cargo.lock',
      ecosystem: 'crates.io',
    });
    expect(detectLockFileType('requirements.txt')).toEqual({
      type: 'requirements.txt',
      ecosystem: 'PyPI',
    });
    expect(detectLockFileType('go.sum')).toEqual({ type: 'go.sum', ecosystem: 'Go' });
    expect(detectLockFileType('Gemfile.lock')).toEqual({
      type: 'Gemfile.lock',
      ecosystem: 'RubyGems',
    });
  });

  it('resolves nested paths by basename', () => {
    expect(detectLockFileType('services/api/package-lock.json')?.type).toBe('package-lock.json');
  });

  it('returns null for non lock files', () => {
    expect(detectLockFileType('src/foo.ts')).toBeNull();
    expect(detectLockFileType('package.json')).toBeNull();
  });

  it('emits OSV-canonical ecosystem casing for PyPI, Go, and RubyGems', () => {
    expect(detectLockFileType('requirements.txt')?.ecosystem).toBe('PyPI');
    expect(detectLockFileType('go.sum')?.ecosystem).toBe('Go');
    expect(detectLockFileType('Gemfile.lock')?.ecosystem).toBe('RubyGems');
  });
});

describe('parsePatchLines', () => {
  it('maps added/context lines to new-file line numbers and skips deletions', () => {
    const patch = ['@@ -10,3 +20,3 @@', ' context', '-removed', '+added', ' trailing'].join('\n');
    const lines = parsePatchLines(patch);
    expect(lines).toEqual([
      { line: 20, text: 'context', added: false, deleted: false },
      { line: 21, text: 'removed', added: false, deleted: true },
      { line: 21, text: 'added', added: true, deleted: false },
      { line: 22, text: 'trailing', added: false, deleted: false },
    ]);
  });

  it('advances the counter across multiple hunks', () => {
    const patch = ['@@ -1,1 +5,1 @@', '+first', '@@ -2,1 +8,1 @@', '+second'].join('\n');
    const lines = parsePatchLines(patch);
    expect(lines.map((l) => l.line)).toEqual([5, 8]);
  });

  it('returns an empty array for an empty patch', () => {
    expect(parsePatchLines('')).toEqual([]);
  });
});

describe('extractChangedDependencies', () => {
  it('extracts an npm version bump from the added lines of a package-lock.json patch', async () => {
    const patch = [
      '@@ -5,7 +5,7 @@',
      '   "dependencies": {',
      '     "node_modules/lodash": {',
      '-      "version": "4.17.20",',
      '+      "version": "4.17.21",',
      '       "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",',
      '       "integrity": "sha512-abc"',
      '     }',
      '   }',
    ].join('\n');
    const deps = await extractChangedDependencies(
      [changedFile('package-lock.json', patch)],
      process.cwd(),
      makeOptions(),
    );
    expect(deps).toHaveLength(1);
    expectDep(deps, 'lodash', '4.17.21');
  });

  it('extracts a yarn v1 version bump', async () => {
    const patch = [
      '@@ -1,4 +1,4 @@',
      ' lodash@^4.17.21:',
      '-  version "4.17.20"',
      '+  version "4.17.21"',
      '   resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz"',
    ].join('\n');
    const deps = await extractChangedDependencies(
      [changedFile('yarn.lock', patch)],
      process.cwd(),
      makeOptions(),
    );
    expectDep(deps, 'lodash', '4.17.21');
  });

  it('extracts scoped packages from a Yarn Berry (v2) lockfile', async () => {
    const patch = [
      '@@ -1,4 +1,4 @@',
      '+"@babel/core@npm:^7.18.6":',
      '+  version: 7.18.9',
      '+  resolution: "@babel/core@npm:7.18.9"',
      '+  checksum: abc',
    ].join('\n');
    const deps = await extractChangedDependencies(
      [changedFile('yarn.lock', patch)],
      process.cwd(),
      makeOptions(),
    );
    expect(deps).toHaveLength(1);
    expectDep(deps, '@babel/core', '7.18.9');
  });

  it('strips the peer-dependency suffix from pnpm package versions', async () => {
    const patch = [
      '@@ -1,3 +1,3 @@',
      '+  /@babel/eslint-parser@7.18.9_@babel+core@7.19.3:',
      '+    resolution: {integrity: sha512-new}',
      '+  /lodash@4.17.21:',
      '+    resolution: {integrity: sha512-new}',
    ].join('\n');
    const deps = await extractChangedDependencies(
      [changedFile('pnpm-lock.yaml', patch)],
      process.cwd(),
      makeOptions(),
    );
    expectDep(deps, '@babel/eslint-parser', '7.18.9');
    expectDep(deps, 'lodash', '4.17.21');
    expect(deps.some((d) => d.version.includes('@babel+core'))).toBe(false);
  });

  it('extracts a Cargo.lock version bump', async () => {
    const patch = [
      '@@ -1,4 +1,4 @@',
      ' name = "serde"',
      '-version = "1.0.188"',
      '+version = "1.0.189"',
      ' source = "registry+https://github.com/rust-lang/crates.io-index"',
    ].join('\n');
    const deps = await extractChangedDependencies(
      [changedFile('Cargo.lock', patch)],
      process.cwd(),
      makeOptions(),
    );
    expectDep(deps, 'serde', '1.0.189');
  });

  it('extracts exact pins from requirements.txt and ignores ranges', async () => {
    const patch = ['@@ -1,3 +1,4 @@', '+requests==2.31.0', '+flask>=2.3.0', '+pytest'].join('\n');
    const deps = await extractChangedDependencies(
      [changedFile('requirements.txt', patch)],
      process.cwd(),
      makeOptions(),
    );
    expect(deps).toHaveLength(1);
    expectDep(deps, 'requests', '2.31.0');
  });

  it('extracts go.sum module lines and excludes /go.mod checksum entries', async () => {
    const patch = [
      '@@ -1,3 +1,4 @@',
      '+github.com/foo/bar v1.2.3 h1:abc',
      '+github.com/foo/baz v1.2.4/go.mod h1:xyz',
    ].join('\n');
    const deps = await extractChangedDependencies(
      [changedFile('go.sum', patch)],
      process.cwd(),
      makeOptions(),
    );
    expect(deps).toHaveLength(1);
    expectDep(deps, 'github.com/foo/bar', 'v1.2.3');
  });

  it('extracts Gemfile.lock spec entries and ignores requirement lines', async () => {
    const patch = [
      '@@ -1,5 +1,6 @@',
      ' GEM',
      '   remote: https://rubygems.org/',
      '   specs:',
      '+    nokogiri (1.14.0)',
      '+      mini_portile2 (~> 2.8)',
    ].join('\n');
    const deps = await extractChangedDependencies(
      [changedFile('Gemfile.lock', patch)],
      process.cwd(),
      makeOptions(),
    );
    expect(deps).toHaveLength(1);
    expectDep(deps, 'nokogiri', '1.14.0');
  });

  it('respects lockFilePatterns and excludePatterns', async () => {
    const patch = ['@@ -1,1 +1,1 @@', '+requests==2.31.0'].join('\n');
    const notMatching = await extractChangedDependencies(
      [changedFile('Pipfile', patch)],
      process.cwd(),
      makeOptions(),
    );
    expect(notMatching).toHaveLength(0);

    const excluded = await extractChangedDependencies(
      [changedFile('requirements.txt', patch)],
      process.cwd(),
      makeOptions({ excludePatterns: ['**/requirements.txt'] }),
    );
    expect(excluded).toHaveLength(0);
  });

  it('skips non-lock files entirely', async () => {
    const deps = await extractChangedDependencies(
      [changedFile('src/foo.ts', '+const x = 1;')],
      process.cwd(),
      makeOptions(),
    );
    expect(deps).toHaveLength(0);
  });

  it('attributes nested transitive dependencies to their own package name', async () => {
    const patch = [
      '@@ -1,5 +1,6 @@',
      ' "node_modules/a": {',
      '   "version": "1.0.0",',
      ' "node_modules/a/node_modules/b": {',
      '+    "version": "2.3.4",',
      '     "resolved": "https://registry.npmjs.org/b/-/b-2.3.4.tgz"',
      '   }',
      ' }',
    ].join('\n');
    const deps = await extractChangedDependencies(
      [changedFile('package-lock.json', patch)],
      process.cwd(),
      makeOptions(),
    );
    expect(deps).toHaveLength(1);
    // The nested dependency must be scanned under its own name, not the parent's.
    expectDep(deps, 'b', '2.3.4');
    expect(deps.some((d) => d.name === 'a')).toBe(false);
  });

  it('skips the whole-file fallback unless includeUnchanged is enabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sca-test-'));
    try {
      writeFileSync(join(dir, 'yarn.lock'), 'lodash@^4.17.21:\n  version "4.17.20"\n');
      const defaultDeps = await extractChangedDependencies(
        [changedFile('yarn.lock')],
        dir,
        makeOptions(),
      );
      expect(defaultDeps).toHaveLength(0);
      const optedIn = await extractChangedDependencies(
        [changedFile('yarn.lock')],
        dir,
        makeOptions({ includeUnchanged: true }),
      );
      expect(optedIn).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to reading the working tree when no patch is present and opted in', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sca-test-'));
    try {
      const content = [
        '"@babel/core@npm:^7.18.6":',
        '  version: 7.18.9',
        '  resolution: "@babel/core@npm:7.18.9"',
        '',
      ].join('\n');
      writeFileSync(join(dir, 'yarn.lock'), content);
      const deps = await extractChangedDependencies(
        [changedFile('yarn.lock')],
        dir,
        makeOptions({ includeUnchanged: true }),
      );
      expect(deps).toHaveLength(1);
      expectDep(deps, '@babel/core', '7.18.9');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
