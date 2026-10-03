import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

/**
 * Write a pull request's changed files into `workDir` the way the review job's
 * base-pinned checkout actually presents them (`.github/workflows/ai-review.yml`
 * pins `actions/checkout` to `github.event.pull_request.base.sha`):
 *
 *  - `added`    -> ABSENT. The base never had the file, so neither does the
 *                  worktree. This is the shape the added-file attack depends on,
 *                  and a test that wants the scanner to see an added file must
 *                  write it deliberately.
 *  - `modified` -> present, at BASE content.
 *  - `removed`  -> present, at BASE content (the base still has it).
 *
 * The content is inert boilerplate: no secret findings, not a generated
 * artifact, so staging only removes the "file absent" confound.
 *
 * This matters because a read failure in the deterministic secret scan is FAIL
 * CLOSED — it becomes a counted critical issue rather than a silent clean pass.
 * Without a staged worktree, every test asserting an exact issue count is really
 * asserting the unscanned-file finding instead of what it means to test.
 *
 * @param pr - The pull request whose changed files should be materialized.
 * @param workDir - Directory to materialize into.
 * @param content - Text written for each staged file.
 */
export function stageChangedFiles(
  pr: PRContext,
  workDir: string,
  content = 'export const value = 1;\n',
): void {
  for (const file of pr.changedFiles) {
    if (!file.path || file.status === 'added') continue;
    const full = path.join(workDir, file.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
  }
}

/**
 * Create a throwaway directory holding a staged copy of `pr`'s changed files,
 * for passing as `reviewPR(pr, { workingDirectory })`. Preferred over `chdir`,
 * because suites that use this have tests that genuinely depend on the process
 * working directory.
 *
 * @param pr - The pull request whose changed files should be materialized.
 * @returns An absolute path to the staged directory.
 */
export function makeStagedWorkDir(pr: PRContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staged-workdir-'));
  stageChangedFiles(pr, dir);
  return dir;
}

export function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    timeoutMinutes: 10,
    // The single-process subagent path is now the default; pin the legacy
    // batch path here so the integration tests keep testing it explicitly.
    multiAgent: { ...DEFAULT_CONFIG.multiAgent, enabled: false },
    ...overrides,
    review: {
      ...DEFAULT_CONFIG.review,
      enableReachability: false,
      ...((overrides.review || {}) as Record<string, unknown>),
    },
  };
}

/**
 * Build an AgentConfig with the meta-verification pass enabled, used by the
 * review-pipeline integration tests. Individual toggles still default to
 * DEFAULT_CONFIG.review values unless overridden.
 *
 * @param overrides - Optional AgentConfig overrides (e.g. `verificationModel`).
 * @returns An AgentConfig with `review.enableMetaVerification` enabled.
 */
export function makeMetaVerificationConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return makeAgentConfig({
    enableMCP: false,
    mcpServers: [],
    ...overrides,
    review: {
      ...DEFAULT_CONFIG.review,
      enableMetaVerification: true,
      ...((overrides.review || {}) as Record<string, unknown>),
    },
  });
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

export const SAMPLE_VERIFICATION_ALL_INVALID_JSONL = [
  '{"type":"verification","issueIndex":0,"valid":false,"reasoning":"False positive."}',
  '{"type":"verification","issueIndex":1,"valid":false,"reasoning":"False positive."}',
  '{"type":"verification","issueIndex":2,"valid":false,"reasoning":"False positive."}',
].join('\n');
