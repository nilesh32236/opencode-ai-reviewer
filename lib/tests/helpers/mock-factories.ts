import { vi } from 'vitest';
import type { AgentConfig, PRContext, ReviewResult } from '../../src/types/index.js';
import { DEFAULT_CONFIG } from '../../src/types/index.js';

export function makePRContext(overrides: Partial<PRContext> = {}): PRContext {
  return {
    number: 42,
    title: 'Test PR',
    body: 'Test body',
    headRef: 'feature',
    headSha: 'abc123',
    baseRef: 'main',
    author: 'test-user',
    labels: [],
    changedFiles: [
      {
        path: 'src/test.ts',
        status: 'modified',
        additions: 10,
        deletions: 2,
        patch: 'diff --git a/src/test.ts b/src/test.ts\n@@ -1 +1 @@\n-old code\n+new code',
      },
    ],
    ...overrides,
  };
}

export function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    timeoutMinutes: 10,
    ...overrides,
  };
}

export function makeReviewResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    summary: 'Review summary.',
    verdict: { ready: false, reasoning: 'Has issues.', autoFixable: false, confidence: 'medium' },
    strengths: [{ type: 'strength', file: 'src/a.ts', line: 10, message: 'Good code.' }],
    issues: [
      {
        type: 'issue',
        severity: 'critical',
        file: 'src/b.ts',
        line: 42,
        message: 'Bug.',
        suggestion: 'Fix it.',
        inline: true,
      },
    ],
    stats: { total: 1, critical: 1, important: 0, minor: 0 },
    rawLines: [],
    failedLines: 0,
    ...overrides,
  };
}

interface MockResponseOptions {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export function mockResponse(overrides: MockResponseOptions = {}): Response {
  const { body, headers: rawHeaders, ...rest } = overrides;
  const headers = new Headers(rawHeaders);
  return {
    ok: true,
    status: 200,
    headers,
    json: vi.fn().mockResolvedValue(body ?? {}),
    text: vi.fn().mockResolvedValue(body !== undefined ? JSON.stringify(body) : ''),
    ...rest,
  } as unknown as Response;
}

export function mockErrorResponse(status: number, statusText = 'Error'): Response {
  return {
    ok: false,
    status,
    statusText,
    headers: new Headers(),
    json: vi.fn().mockRejectedValue(new Error('Not JSON')),
    text: vi.fn().mockResolvedValue(statusText),
  } as unknown as Response;
}

export const SAMPLE_VALID_JSONL = [
  '{"type":"summary","text":"The PR implements JWT authentication middleware. Overall good structure with some security concerns."}',
  '{"type":"verdict","ready":false,"reasoning":"Found 3 issues including one critical security vulnerability."}',
  '{"type":"strength","file":"src/auth/middleware.ts","line":15,"message":"Well-structured middleware with clear error handling."}',
  '{"type":"strength","file":"src/auth/jwt.ts","line":42,"message":"Good use of type-safe JWT payload parsing."}',
  '{"type":"issue","severity":"critical","file":"src/auth/jwt.ts","line":28,"message":"JWT secret hardcoded in source","suggestion":"Use environment variable JWT_SECRET instead of hardcoded value.","inline":true}',
  '{"type":"issue","severity":"important","file":"src/auth/middleware.ts","line":55,"message":"No token expiration check","suggestion":"Add token expiration validation using jwt.verify options.","inline":true}',
  '{"type":"issue","severity":"minor","file":"src/routes/user.ts","line":10,"message":"Unused import of ResponseType","suggestion":"Remove unused import.","inline":false}',
].join('\n');

export const SAMPLE_BATCH_A_JSONL = [
  '{"type":"summary","text":"Batch A: auth module review."}',
  '{"type":"verdict","ready":false,"reasoning":"Issues found in auth module."}',
  '{"type":"issue","severity":"critical","file":"src/auth/jwt.ts","line":28,"message":"Hardcoded secret","inline":true}',
  '{"type":"issue","severity":"important","file":"src/auth/middleware.ts","line":55,"message":"Missing expiration check","inline":true}',
].join('\n');

export const SAMPLE_BATCH_B_JSONL = [
  '{"type":"summary","text":"Batch B: routes module review."}',
  '{"type":"verdict","ready":false,"reasoning":"Issues found in routes module."}',
  '{"type":"issue","severity":"minor","file":"src/routes/user.ts","line":10,"message":"Unused import","inline":false}',
].join('\n');

export const SAMPLE_SYNTHESIS_JSONL = [
  '{"type":"summary","text":"Merged review of all modules."}',
  '{"type":"verdict","ready":false,"reasoning":"Found 3 issues across all modules."}',
  '{"type":"issue","severity":"critical","file":"src/auth/jwt.ts","line":28,"message":"Hardcoded secret","inline":true}',
  '{"type":"issue","severity":"important","file":"src/auth/middleware.ts","line":55,"message":"Missing expiration check","inline":true}',
  '{"type":"issue","severity":"minor","file":"src/routes/user.ts","line":10,"message":"Unused import","inline":false}',
].join('\n');

export const SAMPLE_VERIFICATION_JSONL = [
  '{"type":"verification","issueIndex":0,"valid":true,"reasoning":"Confirmed — hardcoded secret is a real issue."}',
  '{"type":"verification","issueIndex":1,"valid":false,"reasoning":"False positive — JWT lib handles expiration by default."}',
  '{"type":"verification","issueIndex":2,"valid":true,"reasoning":"Confirmed — unused import should be removed."}',
].join('\n');
