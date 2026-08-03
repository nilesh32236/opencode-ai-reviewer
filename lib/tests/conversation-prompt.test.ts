import { describe, expect, it } from 'vitest';
import {
  buildConversationPrompt,
  detectIntent,
  extractCodeReferences,
  resolveCodeReferences,
} from '../src/prompts/conversation.js';
import type { ChangedFile, ConversationContext, PRContext } from '../src/types/index.js';

const BASE_PR: PRContext = {
  number: 42,
  title: 'Fix the bug',
  body: '',
  headRef: 'feature',
  headSha: 'abc123',
  baseRef: 'main',
  author: 'alice',
  labels: [],
  changedFiles: [
    {
      path: 'src/foo.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
      patch: '@@ -40,3 +40,3 @@',
    },
    {
      path: 'src/bar.ts',
      status: 'modified',
      additions: 5,
      deletions: 0,
      patch: '@@ -10,5 +10,6 @@',
    },
    { path: 'tests/foo.test.ts', status: 'added', additions: 3, deletions: 0 },
  ],
};

function makeContext(overrides: Partial<ConversationContext> = {}): ConversationContext {
  return {
    filePath: 'src/foo.ts',
    diffHunk: '@@ -40,3 +40,3 @@',
    thread: [{ role: 'user', body: 'Why is this null?', author: 'alice' }],
    prContext: BASE_PR,
    intent: 'general',
    ...overrides,
  };
}

describe('detectIntent', () => {
  it('classifies explanation requests', () => {
    expect(detectIntent('why does this throw?')).toBe('explain');
    expect(detectIntent('explain this function')).toBe('explain');
    expect(detectIntent('what does this do?')).toBe('explain');
  });

  it('classifies fix requests', () => {
    expect(detectIntent('please fix this null dereference')).toBe('fix');
    expect(detectIntent('change this to use const')).toBe('fix');
  });

  it('classifies general questions', () => {
    expect(detectIntent('thanks for the review!')).toBe('general');
    expect(detectIntent('sounds good')).toBe('general');
  });
});

describe('extractCodeReferences', () => {
  it('extracts a single file:line reference', () => {
    expect(extractCodeReferences('see src/foo.ts:42')).toEqual([{ file: 'src/foo.ts', line: 42 }]);
  });

  it('extracts a file:start-end range', () => {
    expect(extractCodeReferences('check src/bar.ts:10-20')).toEqual([
      { file: 'src/bar.ts', line: 10, endLine: 20 },
    ]);
  });

  it('extracts multiple references in order', () => {
    expect(extractCodeReferences('src/foo.ts:42 and src/bar.ts:5')).toEqual([
      { file: 'src/foo.ts', line: 42 },
      { file: 'src/bar.ts', line: 5 },
    ]);
  });

  it('ignores references inside URLs', () => {
    expect(extractCodeReferences('see https://example.com/file.ts:42 for docs')).toEqual([]);
  });

  it('ignores references inside URLs with ports', () => {
    expect(extractCodeReferences('see https://host:8080/x.ts:42 for docs')).toEqual([]);
    expect(extractCodeReferences('deploy docs at http://example.com/src/foo.ts:1')).toEqual([]);
  });

  it('ignores email-like tokens', () => {
    expect(extractCodeReferences('ping alice@example.com:42 with the question')).toEqual([]);
    expect(extractCodeReferences('mailto:bob@corp.dev:7')).toEqual([]);
  });

  it('ignores non-file tokens like version numbers', () => {
    expect(extractCodeReferences('version 1.0:5 is fine')).toEqual([]);
  });

  it('returns an empty array for empty or non-matching bodies', () => {
    expect(extractCodeReferences('')).toEqual([]);
    expect(extractCodeReferences('no references here')).toEqual([]);
  });
});

describe('resolveCodeReferences', () => {
  it('keeps references that match changed files by exact path', () => {
    const resolved = resolveCodeReferences(
      [{ file: 'src/foo.ts', line: 42 }],
      BASE_PR.changedFiles,
    );
    expect(resolved).toEqual([{ file: 'src/foo.ts', line: 42 }]);
  });

  it('resolves references by unique basename', () => {
    const resolved = resolveCodeReferences([{ file: './foo.ts', line: 3 }], BASE_PR.changedFiles);
    expect(resolved).toEqual([{ file: 'src/foo.ts', line: 3 }]);
  });

  it('drops references to files not in the diff', () => {
    const resolved = resolveCodeReferences(
      [{ file: 'src/missing.ts', line: 1 }],
      BASE_PR.changedFiles,
    );
    expect(resolved).toEqual([]);
  });

  it('drops ambiguous basenames', () => {
    const changedFiles: ChangedFile[] = [
      { path: 'src/util.ts', status: 'modified', additions: 1, deletions: 0 },
      { path: 'lib/util.ts', status: 'modified', additions: 1, deletions: 0 },
    ];
    const resolved = resolveCodeReferences([{ file: 'util.ts', line: 2 }], changedFiles);
    expect(resolved).toEqual([]);
  });

  it('dedupes and caps the number of resolved files', () => {
    const refs = [
      { file: 'src/foo.ts', line: 1 },
      { file: 'src/foo.ts', line: 5 },
      { file: 'src/bar.ts', line: 2 },
    ];
    const resolved = resolveCodeReferences(refs, BASE_PR.changedFiles, 1);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].file).toBe('src/foo.ts');
    expect(resolved[0].line).toBe(1);
  });
});

describe('buildConversationPrompt with code references', () => {
  it('injects a Referenced Code section for resolved refs', () => {
    const context = makeContext({
      codeReferences: [{ file: 'src/foo.ts', line: 42 }],
    });
    const prompt = buildConversationPrompt(context);
    expect(prompt).toContain('## Referenced Code');
    expect(prompt).toContain('`src/foo.ts:42`');
    expect(prompt).toContain('@@ -40,3 +40,3 @@');
  });

  it('renders a range reference with both lines', () => {
    const context = makeContext({
      codeReferences: [{ file: 'src/bar.ts', line: 10, endLine: 20 }],
    });
    const prompt = buildConversationPrompt(context);
    expect(prompt).toContain('`src/bar.ts:10-20`');
  });

  it('renders a fallback note when the referenced file has no patch', () => {
    const context = makeContext({
      codeReferences: [{ file: 'tests/foo.test.ts', line: 2 }],
    });
    const prompt = buildConversationPrompt(context);
    expect(prompt).toContain('No diff available for this file in the PR');
  });

  it('omits the section when no code references are present', () => {
    const prompt = buildConversationPrompt(makeContext());
    expect(prompt).not.toContain('## Referenced Code');
  });

  it('omits the section for an empty references array', () => {
    const prompt = buildConversationPrompt(makeContext({ codeReferences: [] }));
    expect(prompt).not.toContain('## Referenced Code');
  });
});

describe('buildConversationPrompt referenced-code patch window', () => {
  const multiHunkPatch = [
    '@@ -1,3 +1,3 @@',
    '-a',
    '+b',
    ' c',
    ' d',
    '@@ -40,3 +40,3 @@',
    '-x',
    '+y',
    ' z',
    ' w',
  ].join('\n');

  it('renders the hunk covering the referenced line instead of the patch head', () => {
    const context = makeContext({
      prContext: {
        ...BASE_PR,
        changedFiles: [
          {
            path: 'src/foo.ts',
            status: 'modified',
            additions: 6,
            deletions: 2,
            patch: multiHunkPatch,
          },
        ],
      },
      codeReferences: [{ file: 'src/foo.ts', line: 41 }],
    });
    const prompt = buildConversationPrompt(context);
    expect(prompt).toContain('@@ -40,3 +40,3 @@');
    expect(prompt).toContain('+y');
    expect(prompt).not.toContain('+b');
  });

  it('falls back to the patch head when the referenced line is not in any hunk', () => {
    const context = makeContext({
      prContext: {
        ...BASE_PR,
        changedFiles: [
          {
            path: 'src/foo.ts',
            status: 'modified',
            additions: 6,
            deletions: 2,
            patch: multiHunkPatch,
          },
        ],
      },
      codeReferences: [{ file: 'src/foo.ts', line: 100 }],
    });
    const prompt = buildConversationPrompt(context);
    expect(prompt).toContain('+b');
  });
});
