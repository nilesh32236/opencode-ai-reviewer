import * as exec from '@actions/exec';
import type { AgentConfig, PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runFixIssue } from '../src/fix';
import type { ActionInputs } from '../src/inputs';

vi.mock('@actions/exec', () => ({
  exec: vi.fn(),
  getExecOutput: vi.fn(),
}));

vi.mock('../src/utils.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    resolvePrNumber: vi.fn().mockResolvedValue(123),
  };
});

describe('runFixIssue with invalid refs', () => {
  beforeEach(() => {
    process.env.GITHUB_EVENT_NAME = 'issue_comment';
  });

  it('should reject invalid defaultBranch before exec', async () => {
    const gh = {
      getIssue: vi.fn().mockResolvedValue({ title: 'foo', body: 'bar' }),
      getDefaultBranch: vi.fn().mockResolvedValue('--upload-pack=touch'),
    } as unknown as PlatformAdapter;

    const engine = {} as ReviewEngine;
    const inputs = {} as ActionInputs;
    const config = {} as AgentConfig;

    await expect(runFixIssue(inputs, config, engine, gh, 123)).rejects.toThrow(
      /Ref name must not begin with a dash/,
    );
    expect(exec.exec).not.toHaveBeenCalled();
  });
});
