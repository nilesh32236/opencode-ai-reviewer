import { describe, expect, it } from 'vitest';
import {
  isGeneratedArtifact,
  isGeneratedArtifactPath,
  isMinifiedContent,
} from '../../src/utils/generated-files.js';

describe('isGeneratedArtifactPath', () => {
  it('treats the committed action/lib bundle as generated', () => {
    expect(isGeneratedArtifactPath('action/lib/index.js')).toBe(true);
    expect(isGeneratedArtifactPath('action/lib/post/index.js')).toBe(true);
  });

  it('treats well-known build/vendor directories as generated', () => {
    expect(isGeneratedArtifactPath('packages/app/dist/main.js')).toBe(true);
    expect(isGeneratedArtifactPath('coverage/lcov-report/index.html')).toBe(true);
    expect(isGeneratedArtifactPath('node_modules/foo/index.js')).toBe(true);
    expect(isGeneratedArtifactPath('vendor/github.com/x/y.go')).toBe(true);
    expect(isGeneratedArtifactPath('.next/server/page.js')).toBe(true);
  });

  it('treats minified/bundled/source-map final segments as generated', () => {
    expect(isGeneratedArtifactPath('public/app.min.js')).toBe(true);
    expect(isGeneratedArtifactPath('public/app.bundle.js')).toBe(true);
    expect(isGeneratedArtifactPath('src/api.generated.ts')).toBe(true);
    expect(isGeneratedArtifactPath('public/app.js.map')).toBe(true);
  });

  it('does not flag ordinary source files', () => {
    expect(isGeneratedArtifactPath('lib/src/engine.ts')).toBe(false);
    expect(isGeneratedArtifactPath('action/src/index.ts')).toBe(false);
    expect(isGeneratedArtifactPath('src/utils/generated-files.ts')).toBe(false);
    expect(isGeneratedArtifactPath('src/map.ts')).toBe(false);
    expect(isGeneratedArtifactPath('')).toBe(false);
  });

  it('handles Windows-style separators', () => {
    expect(isGeneratedArtifactPath('action\\lib\\index.js')).toBe(true);
    expect(isGeneratedArtifactPath('lib\\src\\engine.ts')).toBe(false);
  });
});

describe('isMinifiedContent', () => {
  it('flags content whose first line is very long', () => {
    const minified = `var a=1;${'x=1;'.repeat(600)}`;
    expect(isMinifiedContent(minified)).toBe(true);
  });

  it('flags large files carrying a bundler source-map trailer', () => {
    const bundled = `${'const a = 1;\n'.repeat(8000)}//# sourceMappingURL=index.js.map`;
    expect(isMinifiedContent(bundled)).toBe(true);
  });

  it('does not flag ordinary multi-line source', () => {
    const source = ['import x from "y";', '', 'export function f() {', '  return 1;', '}'].join(
      '\n',
    );
    expect(isMinifiedContent(source)).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(isMinifiedContent('')).toBe(false);
  });
});

describe('isGeneratedArtifact', () => {
  it('skips generated paths without needing content', () => {
    expect(isGeneratedArtifact('action/lib/index.js')).toBe(true);
  });

  it('detects a generated-looking file by content alone', () => {
    const minified = `var a=1;${'x=1;'.repeat(600)}`;
    expect(isGeneratedArtifact('src/looks-normal.ts', minified)).toBe(true);
  });

  it('keeps ordinary source', () => {
    expect(isGeneratedArtifact('src/index.ts', 'export const a = 1;\n')).toBe(false);
  });
});
