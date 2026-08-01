import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/utils/command-match.js';

describe('parseCommand', () => {
  it('parses basic slash commands at line start', () => {
    expect(parseCommand('/fix')?.command).toBe('fix');
    expect(parseCommand('/review')?.command).toBe('review');
    expect(parseCommand('/audit')?.command).toBe('audit');
    expect(parseCommand('/analyze')?.command).toBe('analyze');
    expect(parseCommand('/analyse')?.command).toBe('analyze');
    expect(parseCommand('/explain')?.command).toBe('explain');
    expect(parseCommand('/setup')?.command).toBe('setup');
    expect(parseCommand('/oc setup')?.command).toBe('setup');
  });

  it('handles /oc prefix', () => {
    expect(parseCommand('/oc fix')?.command).toBe('fix');
    expect(parseCommand('/oc analyze')?.command).toBe('analyze');
    expect(parseCommand('  /oc review')?.command).toBe('review');
  });

  it('parses flags correctly', () => {
    const res = parseCommand('/fix --force --dry-run --reason="testing fix"');
    expect(res?.command).toBe('fix');
    expect(res?.flags.force).toBe(true);
    expect(res?.flags.dryRun).toBe(true);
    expect(res?.flags.reason).toBe('testing fix');
  });

  it('parses positional arguments', () => {
    const res = parseCommand('/audit security lib/src');
    expect(res?.command).toBe('audit');
    expect(res?.args).toEqual(['security', 'lib/src']);
  });

  it('parses --force flag as boolean true', () => {
    expect(parseCommand('/fix --force')?.flags.force).toBe(true);
  });

  it('parses --force-with-lease flag correctly', () => {
    expect(parseCommand('/fix --force-with-lease')?.flags.forceWithLease).toBe(true);
  });

  it('rejects commands that are not at line start', () => {
    expect(parseCommand('what is the /fix command?')).toBeNull();
    expect(parseCommand('I will /analyze this tomorrow')).toBeNull();
  });

  it('rejects partial word matches', () => {
    expect(parseCommand('/fixed-issue')).toBeNull();
    expect(parseCommand('/analyzer')).toBeNull();
  });

  it('finds command in multi-line body', () => {
    const body = 'Hello team,\n\n/fix --force\n\nThanks!';
    const res = parseCommand(body);
    expect(res?.command).toBe('fix');
    expect(res?.flags.force).toBe(true);
  });

  it('returns null for non-command strings', () => {
    expect(parseCommand('')).toBeNull();
    expect(parseCommand('Just a regular comment')).toBeNull();
  });
});
