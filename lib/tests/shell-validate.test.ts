import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ReviewIssue } from '../src/types/index.js';
import type { ShellRunDeps } from '../src/utils/shell-validate.js';
import {
  attachShellEvidence,
  collectFindingEvidence,
  resolveShellValidateOptions,
} from '../src/utils/shell-validate.js';

function makeIssue(overrides: Partial<ReviewIssue> = {}): ReviewIssue {
  return {
    type: 'issue',
    severity: 'important',
    file: 'src/a.ts',
    line: 10,
    message: 'Possible bug.',
    ...overrides,
  };
}

/** Stub runner: records calls, returns canned stdout. */
function stubRun(stdout = 'evidence-output'): { deps: ShellRunDeps; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    deps: {
      run: vi.fn(async (...args: unknown[]) => {
        calls.push(args);
        return stdout;
      }),
    },
  };
}

describe('resolveShellValidateOptions', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'shell-validate-'));

  it('stays disabled unless explicitly enabled with commands', () => {
    expect(resolveShellValidateOptions(false, [['tsc', '--version']], root)).toBeUndefined();
    expect(resolveShellValidateOptions(undefined, [['tsc', '--version']], root)).toBeUndefined();
    expect(resolveShellValidateOptions(true, [], root)).toBeUndefined();
    expect(resolveShellValidateOptions(true, undefined, root)).toBeUndefined();
    expect(resolveShellValidateOptions(true, [['tsc', '--version']], '')).toBeUndefined();
  });

  it('rejects non-allowlisted basenames at resolve time', () => {
    expect(resolveShellValidateOptions(true, [['rm', '-rf', 'x']], root)).toBeUndefined();
    expect(
      resolveShellValidateOptions(
        true,
        [
          ['tsc', '--version'],
          ['evil', 'x'],
        ],
        root,
      ),
    ).toBeUndefined();
  });

  it('accepts well-formed allowlisted templates', () => {
    const resolved = resolveShellValidateOptions(true, [['tsc', '--noEmit', '{file}']], root);
    expect(resolved).toEqual({ commands: [['tsc', '--noEmit', '{file}']], workDir: root });
  });
});

describe('collectFindingEvidence', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'shell-validate-collect-'));
  const target = path.join(root, 'a.ts');
  writeFileSync(target, 'export const x = 1;\n');

  it('runs validated commands and captures stdout', async () => {
    const { deps, calls } = stubRun('v5.8.0');
    const evidence = await collectFindingEvidence(
      makeIssue(),
      { commands: [['tsc', '--version']], workDir: root },
      deps,
    );
    expect(evidence).toEqual(['v5.8.0']);
    expect(calls[0][0]).toBe('tsc');
  });

  it('substitutes {file}/{line} placeholders', async () => {
    const { deps, calls } = stubRun('');
    await collectFindingEvidence(
      makeIssue({ file: 'a.ts', line: 7 }),
      { commands: [['tsc', '--noEmit', '{file}:{line}']], workDir: root },
      deps,
    );
    expect(calls[0][1]).toEqual(['--noEmit', 'a.ts:7']);
  });

  it('skips files outside the workdir (confinement)', async () => {
    const { calls } = stubRun('x');
    const evidence = await collectFindingEvidence(makeIssue({ file: '../../etc/passwd' }), {
      commands: [['tsc', '--version']],
      workDir: root,
    });
    expect(evidence).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('fails open when the runner throws', async () => {
    const evidence = await collectFindingEvidence(
      makeIssue(),
      {
        commands: [['tsc', '--version']],
        workDir: path.join(root, 'does-not-exist'),
      },
      {
        run: async () => {
          throw new Error('ENOENT');
        },
      },
    );
    expect(evidence).toEqual([]);
  });
});

describe('attachShellEvidence', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'shell-validate-attach-'));

  it('annotates findings with evidence without mutating inputs', async () => {
    const { deps } = stubRun('confirmed');
    const issue = makeIssue();
    const out = await attachShellEvidence(
      [issue],
      { commands: [['tsc', '--version']], workDir: root },
      deps,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).not.toBe(issue);
    expect(out[0].validationEvidence).toBe('confirmed');
    expect(issue.validationEvidence).toBeUndefined();
  });

  it('passes findings through when nothing validates', async () => {
    const { deps } = stubRun('');
    const issue = makeIssue();
    const out = await attachShellEvidence(
      [issue],
      { commands: [['tsc', '--version']], workDir: root },
      deps,
    );
    expect(out[0]).toBe(issue);
  });
});
