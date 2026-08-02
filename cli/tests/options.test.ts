import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/options.js';

describe('parseCliArgs', () => {
  it('shows help for no arguments', () => {
    expect(parseCliArgs([])).toEqual({ kind: 'help' });
  });

  it('shows help for the help aliases', () => {
    expect(parseCliArgs(['help'])).toEqual({ kind: 'help' });
    expect(parseCliArgs(['--help'])).toEqual({ kind: 'help' });
  });

  it('shows version for the version aliases', () => {
    expect(parseCliArgs(['--version'])).toEqual({ kind: 'version' });
    expect(parseCliArgs(['-v'])).toEqual({ kind: 'version' });
    expect(parseCliArgs(['version'])).toEqual({ kind: 'version' });
  });

  it('resolves a bare `review` to staged mode (the documented default)', () => {
    const result = parseCliArgs(['review']);
    expect(result).toEqual({
      kind: 'review',
      options: {
        staged: true,
        output: 'terminal',
        timeoutMinutes: undefined,
      },
    });
  });

  it('resolves explicit --staged to staged mode', () => {
    const result = parseCliArgs(['review', '--staged']);
    expect(result.kind).toBe('review');
    if (result.kind === 'review') {
      expect(result.options.staged).toBe(true);
      expect(result.options.branch).toBeUndefined();
    }
  });

  it('accepts flags before the review subcommand', () => {
    const result = parseCliArgs(['--staged']);
    expect(result.kind).toBe('review');
    if (result.kind === 'review') {
      expect(result.options.staged).toBe(true);
    }
    const branch = parseCliArgs(['--branch', 'main']);
    expect(branch.kind).toBe('review');
    if (branch.kind === 'review') {
      expect(branch.options.branch).toBe('main');
    }
  });

  it('resolves --branch to branch mode with the branch set', () => {
    const result = parseCliArgs(['review', '--branch', 'main']);
    expect(result.kind).toBe('review');
    if (result.kind === 'review') {
      expect(result.options.staged).toBe(false);
      expect(result.options.branch).toBe('main');
    }
  });

  it('rejects --staged together with --branch', () => {
    const result = parseCliArgs(['review', '--staged', '--branch', 'main']);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.code).toBe(2);
      expect(result.message).toContain('mutually exclusive');
    }
  });

  it('rejects an unknown output format', () => {
    const result = parseCliArgs(['review', '--output', 'bogus']);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.code).toBe(2);
      expect(result.message).toContain('invalid output format');
    }
  });

  it('rejects non-numeric --timeout-minutes', () => {
    const result = parseCliArgs(['review', '--timeout-minutes', 'abc']);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.code).toBe(2);
      expect(result.message).toContain('invalid --timeout-minutes');
    }
  });

  it('rejects non-positive --timeout-minutes', () => {
    const result = parseCliArgs(['review', '--timeout-minutes', '0']);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.code).toBe(2);
    }
  });

  it('parses valid --timeout-minutes and --config', () => {
    const result = parseCliArgs(['review', '--timeout-minutes', '15', '--config', 'my.yml']);
    expect(result.kind).toBe('review');
    if (result.kind === 'review') {
      expect(result.options.timeoutMinutes).toBe(15);
      expect(result.options.configPath).toBe('my.yml');
    }
  });

  it('rejects an unknown command with a usage error', () => {
    const result = parseCliArgs(['frobnicate']);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.code).toBe(2);
      expect(result.message).toContain('unknown command');
      expect(result.showHelp).toBe(true);
    }
  });

  it('treats --help after the subcommand as help', () => {
    expect(parseCliArgs(['review', '--help'])).toEqual({ kind: 'help' });
  });
});
