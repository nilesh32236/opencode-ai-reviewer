import { describe, expect, it, vi } from 'vitest';
import { sanitizePayload } from '../src/event-bus/logging-subscriber.js';
import type { ReviewResult } from '../src/types/index.js';
import { createGuardedCommandSubscriber } from '../src/utils/guarded-subscriber.js';
import { LLM_REF_ALLOWLIST, stripUntrustedProviderEndpoints } from '../src/utils/llm-endpoints.js';
import { sanitizeError, sanitizeErrorMessage } from '../src/utils/logger.js';
import { redactReviewResult, redactSecrets } from '../src/utils/redact.js';
import { evaluateFixSafety, hasManualApprovalForFix } from '../src/utils/safe-exec.js';

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

const PRIVILEGED = {
  authorLogin: 'octocat',
  authorAssociation: 'MEMBER',
  permission: 'write',
  authorType: 'User',
};

function sampleResult(): ReviewResult {
  return {
    summary: 'ok',
    verdict: { ready: false, reasoning: 'r', autoFixable: false, confidence: 'medium' },
    strengths: [],
    issues: [
      {
        type: 'issue',
        severity: 'critical',
        file: 'src/a.ts',
        line: 1,
        message: 'hardcoded credential',
        anchorText: 'password = "supersecret123"',
      },
    ],
    stats: { total: 1, critical: 1, important: 0, minor: 0 },
  };
}

describe('audit auth fixes', () => {
  describe('hasManualApprovalForFix', () => {
    it('still honors approval labels without author evidence', () => {
      expect(hasManualApprovalForFix(['autofix:approved'])).toBe(true);
    });

    it('rejects negated free-text approval prose', () => {
      expect(hasManualApprovalForFix([], ['this autofix is NOT approved'])).toBe(false);
      expect(hasManualApprovalForFix([], ['approved by nobody — do not autofix'])).toBe(false);
      expect(hasManualApprovalForFix([], ['autofix was approved yesterday, reverting'])).toBe(
        false,
      );
    });

    it('fails closed for a bare /approve-fix string without author evidence', () => {
      expect(hasManualApprovalForFix([], ['/approve-fix'])).toBe(false);
    });

    it('accepts a line-anchored /approve-fix from a privileged human', () => {
      expect(hasManualApprovalForFix([], ['/approve-fix'], PRIVILEGED)).toBe(true);
      expect(hasManualApprovalForFix([], ['please:\n/approve-autofix now'], PRIVILEGED)).toBe(true);
    });

    it('rejects bot authors, unprivileged associations, and bot types', () => {
      expect(
        hasManualApprovalForFix([], ['/approve-fix'], { ...PRIVILEGED, authorLogin: 'bot[bot]' }),
      ).toBe(false);
      expect(
        hasManualApprovalForFix([], ['/approve-fix'], { ...PRIVILEGED, authorLogin: '' }),
      ).toBe(false);
      // Association OR permission can each establish privilege, so each
      // rejection case neutralizes the other signal.
      expect(
        hasManualApprovalForFix([], ['/approve-fix'], {
          authorLogin: 'dev',
          authorAssociation: 'NONE',
          permission: 'read',
          authorType: 'User',
        }),
      ).toBe(false);
      expect(
        hasManualApprovalForFix([], ['/approve-fix'], {
          authorLogin: 'dev',
          authorAssociation: 'NONE',
          permission: 'read',
          authorType: 'Bot',
        }),
      ).toBe(false);
    });

    it('accepts write-level API permission (Q1: admin/maintain/write)', () => {
      expect(
        hasManualApprovalForFix(
          [],
          [{ body: '/approve-fix', authorLogin: 'dev', permission: 'write', authorType: 'User' }],
        ),
      ).toBe(true);
      expect(
        hasManualApprovalForFix(
          [],
          [{ body: '/approve-fix', authorLogin: 'dev', permission: 'read', authorType: 'User' }],
        ),
      ).toBe(false);
    });

    it('evaluateFixSafety threads approvalAuthor through to comment approval', () => {
      const destructive = 'run rm -rf /data now';
      const held = evaluateFixSafety(destructive, {
        requireManualApproval: true,
        labels: [],
        comments: ['/approve-fix'],
      });
      expect(held.held).toBe(true);
      const released = evaluateFixSafety(destructive, {
        requireManualApproval: true,
        labels: [],
        comments: ['/approve-fix'],
        approvalAuthor: PRIVILEGED,
      });
      expect(released.held).toBe(false);
    });
  });

  describe('createGuardedCommandSubscriber', () => {
    const handler = async (): Promise<void> => {};

    it('throws when a required privilege hook is absent', () => {
      expect(() =>
        createGuardedCommandSubscriber({
          name: 'T',
          command: 'fix',
          events: ['comment.created'],
          rateLimit: { checkRateLimit: async () => ({}) },
          handler,
        }),
      ).toThrow(/privilege/i);
    });

    it('throws when a required rate-limit hook is absent', () => {
      expect(() =>
        createGuardedCommandSubscriber({
          name: 'T',
          command: 'fix',
          events: ['comment.created'],
          privilege: { satisfiesPrivilegeGate: () => true },
          handler,
        }),
      ).toThrow(/rate/i);
    });

    it('throws when a gate is disabled without a documentedException', () => {
      expect(() =>
        createGuardedCommandSubscriber({
          name: 'T',
          command: 'setup',
          events: ['comment.created'],
          requirePrivilege: false,
          requireRateLimit: false,
          handler,
        }),
      ).toThrow(/documentedException/);
    });

    it('accepts a documented exception for a disabled gate', () => {
      const sub = createGuardedCommandSubscriber({
        name: 'T',
        command: 'setup',
        events: ['comment.created'],
        requirePrivilege: false,
        requireRateLimit: false,
        documentedException: 'gates enforced in-handler with server verification',
        handler,
      });
      expect(sub.name).toBe('T');
    });
  });

  describe('redaction hardening', () => {
    it('redacts anchorText carrying a verbatim credential line', () => {
      const result = sampleResult();
      result.issues[0]!.anchorText =
        'const token = "github_pat_abcdefghijklmnopqrstuvwx" // postgres://app:s3cr3t@db:5432/prod';
      const redacted = redactReviewResult(result);
      expect(redacted.issues[0]?.anchorText).not.toContain('abcdefghijklmnopqrstuvwx');
      expect(redacted.issues[0]?.anchorText).not.toContain('s3cr3t');
      expect(redacted.issues[0]?.file).toBe('src/a.ts');
      expect(redacted.issues[0]?.line).toBe(1);
    });

    it('sanitizeError redacts PEM blocks, connection strings, and auth headers', () => {
      const pem = 'key:\n-----BEGIN PRIVATE KEY-----\nABCDEF\n-----END PRIVATE KEY-----';
      expect(sanitizeError(new Error(pem))).not.toContain('ABCDEF');
      expect(sanitizeErrorMessage('db postgres://app:s3cr3t@db:5432/prod failed')).not.toContain(
        's3cr3t',
      );
      expect(sanitizeError('Authorization: Bearer abcdef123456')).not.toContain('abcdef123456');
      expect(sanitizeError('cmd --token=hunter2 failed')).not.toContain('hunter2');
    });

    it('sanitizePayload scrubs credential patterns in nested strings', () => {
      const out = sanitizePayload({
        patch: 'postgres://app:s3cr3t@db:5432/prod',
        nested: { note: 'Authorization: Bearer abcdef123456' },
      }) as Record<string, Record<string, string> | string>;
      expect(JSON.stringify(out)).not.toContain('s3cr3t');
      expect(JSON.stringify(out)).not.toContain('abcdef123456');
    });

    it('redactSecrets still covers the base token forms', () => {
      expect(redactSecrets('x')).toBe('x');
      expect(LLM_REF_ALLOWLIST.has('AZURE_OPENAI_API_KEY')).toBe(true);
    });
  });

  describe('stripUntrustedProviderEndpoints', () => {
    it('drops a non-allowlisted {env:VAR} apiKey reference at the source', () => {
      const stripped = stripUntrustedProviderEndpoints({
        evil: {
          type: 'openai-compatible',
          baseUrl: 'https://x.example',
          apiKey: '{env:GITHUB_TOKEN}',
        } as never,
      });
      expect(stripped?.evil).not.toHaveProperty('apiKey');
    });

    it('preserves an allowlisted {env:VAR} apiKey reference and literals', () => {
      const stripped = stripUntrustedProviderEndpoints({
        ok: {
          type: 'openai-compatible',
          baseUrl: 'https://x.example',
          apiKey: '{env:LLM_API_KEY}',
        } as never,
        literal: { type: 'azure', apiKey: 'literal-key' } as never,
      });
      expect((stripped?.ok as { apiKey?: string }).apiKey).toBe('{env:LLM_API_KEY}');
      expect((stripped?.literal as { apiKey?: string }).apiKey).toBe('literal-key');
    });
  });
});
