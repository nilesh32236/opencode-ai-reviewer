import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockContext } = vi.hoisted(() => {
  const _mockContext = {
    actor: 'workflow-actor',
    payload: {} as Record<string, unknown>,
  };
  return { mockContext: _mockContext };
});

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  saveState: vi.fn(),
  setSecret: vi.fn(),
}));

vi.mock('@actions/exec', () => ({
  exec: vi.fn(),
  getExecOutput: vi.fn(),
}));

vi.mock('@actions/github', () => ({
  context: mockContext,
  getOctokit: vi.fn(),
}));

import {
  appendOperatorInstruction,
  buildOperatorInstructionSection,
  resolveOperatorActor,
  resolveOperatorInstruction,
} from '../src/fix.js';
import type { ActionInputs } from '../src/inputs.js';

function inputsWith(commentBody?: string): Pick<ActionInputs, 'commentBody'> {
  return { commentBody };
}

describe('appendOperatorInstruction()', () => {
  it('returns context byte-identical when instruction is missing/blank', () => {
    expect(appendOperatorInstruction('ctx')).toBe('ctx');
    expect(appendOperatorInstruction('ctx', '')).toBe('ctx');
    expect(appendOperatorInstruction('ctx', '   ')).toBe('ctx');
    expect(appendOperatorInstruction('ctx', undefined)).toBe('ctx');
  });

  it('appends a provenanced section otherwise', () => {
    const out = appendOperatorInstruction('ctx', 'rebase please', 'alice');
    expect(out).toContain('ctx');
    expect(out).toContain('rebase please');
    expect(out).toContain('@alice');
  });
});

describe('buildOperatorInstructionSection()', () => {
  it('rejects unsafe actor logins', () => {
    const out = buildOperatorInstructionSection('do X', 'evil\nactor');
    expect(out).not.toContain('evil');
    expect(out).toContain('authorized /fix comment');
  });
});

describe('resolveOperatorInstruction()', () => {
  it('returns undefined when there is no instruction', () => {
    expect(resolveOperatorInstruction(inputsWith(undefined))).toBeUndefined();
    expect(resolveOperatorInstruction(inputsWith(''))).toBeUndefined();
    expect(resolveOperatorInstruction(inputsWith('/fix'))).toBeUndefined();
  });

  it('rejects non-fix text and classifies fix text', () => {
    expect(resolveOperatorInstruction(inputsWith('/review do X'))).toBeUndefined();
    expect(resolveOperatorInstruction(inputsWith('/fix rebase onto main'))).toBe(
      'rebase onto main',
    );
  });

  it('prefers the explicit override over inputs', () => {
    expect(resolveOperatorInstruction(inputsWith('/fix from input'), '/fix from override')).toBe(
      'from override',
    );
  });
});

describe('resolveOperatorActor()', () => {
  beforeEach(() => {
    mockContext.actor = 'workflow-actor';
    mockContext.payload = {};
  });

  it('returns the explicit actor when valid', () => {
    expect(resolveOperatorActor({ instruction: '/fix x', actor: 'alice' })).toBe('alice');
  });

  it('returns the comment login when present', () => {
    mockContext.payload = { comment: { body: '/fix x', user: { login: 'bob' } } };
    expect(resolveOperatorActor({ instruction: '/fix x' })).toBe('bob');
  });

  it('does not fall back to context.actor without a comment payload', () => {
    mockContext.actor = 'scheduler';
    mockContext.payload = {};
    expect(resolveOperatorActor({ instruction: '/fix x' })).toBeUndefined();
    expect(resolveOperatorActor()).toBeUndefined();
  });

  it('falls back to context.actor only when a comment body exists', () => {
    mockContext.actor = 'commenter';
    mockContext.payload = { comment: { body: '/fix x' } };
    expect(resolveOperatorActor({ instruction: '/fix x' })).toBe('commenter');
  });
});
