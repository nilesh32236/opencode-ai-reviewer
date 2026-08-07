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
    expect(parseCommand('/describe')?.command).toBe('describe');
    expect(parseCommand('/ask')?.command).toBe('ask');
    expect(parseCommand('/setup')?.command).toBe('setup');
    expect(parseCommand('/docs')?.command).toBe('docs');
    expect(parseCommand('/dismiss')?.command).toBe('dismiss');
    expect(parseCommand('/oc setup')?.command).toBe('setup');
  });

  it('handles /oc prefix', () => {
    expect(parseCommand('/oc fix')?.command).toBe('fix');
    expect(parseCommand('/oc analyze')?.command).toBe('analyze');
    expect(parseCommand('  /oc review')?.command).toBe('review');
    expect(parseCommand('/oc docs')?.command).toBe('docs');
  });

  it('parses /docs style flag', () => {
    const res = parseCommand('/docs --style=tsdoc');
    expect(res?.command).toBe('docs');
    expect(res?.flags.style).toBe('tsdoc');
  });

  it('rejects partial /docs word matches', () => {
    expect(parseCommand('/documentation')).toBeNull();
    expect(parseCommand('please document this /docs later')).toBeNull();
    expect(parseCommand('/docs.ts')).toBeNull();
    expect(parseCommand('/docs-something')).toBeNull();
    expect(parseCommand('/docs_more')).toBeNull();
    expect(parseCommand('/docs9')).toBeNull();
  });

  it('rejects suffixed /describe tokens', () => {
    expect(parseCommand('/describe-draft')).toBeNull();
    expect(parseCommand('/describe.md')).toBeNull();
    expect(parseCommand('/describe_draft')).toBeNull();
    expect(parseCommand('/describe9')).toBeNull();
    expect(parseCommand('/describing')).toBeNull();
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

  it('parses /dismiss with a reason argument', () => {
    const res = parseCommand('/dismiss false_positive');
    expect(res?.command).toBe('dismiss');
    expect(res?.args).toEqual(['false_positive']);
  });

  it('parses /dismiss with a reason flag', () => {
    const res = parseCommand('/dismiss --reason=intentional');
    expect(res?.command).toBe('dismiss');
    expect(res?.flags.reason).toBe('intentional');
  });

  it('parses /oc dismiss with an out_of_scope reason', () => {
    const res = parseCommand('/oc dismiss out_of_scope');
    expect(res?.command).toBe('dismiss');
    expect(res?.args).toEqual(['out_of_scope']);
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

  describe('/ask', () => {
    it('parses a bare /ask command', () => {
      const res = parseCommand('/ask');
      expect(res?.command).toBe('ask');
      expect(res?.args).toEqual([]);
    });

    it('parses /ask with a question as positional args', () => {
      const res = parseCommand('/ask why is this null?');
      expect(res?.command).toBe('ask');
      expect(res?.args).toEqual(['why', 'is', 'this', 'null?']);
    });

    it('parses /ask with a file:line code reference', () => {
      const res = parseCommand('/ask src/foo.ts:42 why is this null?');
      expect(res?.command).toBe('ask');
      expect(res?.args[0]).toBe('src/foo.ts:42');
    });

    it('parses /oc ask with the /oc prefix', () => {
      expect(parseCommand('/oc ask what does this do?')?.command).toBe('ask');
      expect(parseCommand('  /oc ask explain')?.command).toBe('ask');
    });

    it('rejects partial word matches', () => {
      expect(parseCommand('/ask-me-anything')).toBeNull();
    });

    it('finds /ask on a line within a multi-line body', () => {
      const res = parseCommand('Hello,\n\n/ask explain this function\n\nThanks!');
      expect(res?.command).toBe('ask');
    });
  });
});
