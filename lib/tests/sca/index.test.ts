import { describe, expect, it, vi } from 'vitest';
import { runSCAScan, scaVulnerabilityToIssue } from '../../src/sca/index.js';
import type { SCAScanOptions } from '../../src/sca/types.js';
import {
  type ChangedFile,
  DEFAULT_SCA_LOCK_FILE_PATTERNS,
  type ReviewIssue,
  type SCAVulnerability,
} from '../../src/types/index.js';
import type { Logger } from '../../src/utils/logger.js';

const noopLogger = { warn: () => {}, info: () => {} } as unknown as Logger;

function changedFile(path: string, patch: string): ChangedFile {
  return {
    path,
    status: 'modified',
    additions: 0,
    deletions: 0,
    patch,
  };
}

function makeOptions(overrides: Partial<SCAScanOptions> = {}): SCAScanOptions {
  return {
    enabled: true,
    minSeverity: 'important',
    lockFilePatterns: DEFAULT_SCA_LOCK_FILE_PATTERNS,
    excludePatterns: [],
    ...overrides,
  };
}

function makeVuln(partial: Partial<SCAVulnerability> = {}): SCAVulnerability {
  return {
    dependency: {
      file: 'package-lock.json',
      line: 12,
      name: 'lodash',
      version: '4.17.19',
      ecosystem: 'npm',
    },
    id: 'GHSA-lodash',
    cveIds: ['CVE-2021-23337'],
    summary: 'Prototype pollution in lodash',
    severity: 'critical',
    cvssScore: 9.8,
    fixedVersion: '4.17.21',
    references: ['https://example.com/advisory'],
    ...partial,
  };
}

/** A fetch stub that answers OSV querybatch + hydration with canned records. */
function osvStub(lodashSeverity: 'critical' | 'important' | 'minor'): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v1/querybatch')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        queries: Array<{ package: { name: string } }>;
      };
      const results = (body.queries ?? []).map((q) => {
        if (q.package.name === 'lodash') {
          return { vulns: [{ id: 'GHSA-lodash', modified: '2024-01-01T00:00:00Z' }] };
        }
        return {};
      });
      return new Response(JSON.stringify({ results }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/v1/vulns/')) {
      return new Response(
        JSON.stringify({
          id: 'GHSA-lodash',
          aliases: ['CVE-2021-23337'],
          summary: 'Prototype pollution in lodash',
          severity:
            lodashSeverity === 'critical'
              ? [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }]
              : lodashSeverity === 'important'
                ? [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N' }]
                : [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N' }],
          affected: [
            {
              package: { name: 'lodash' },
              ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '4.0.0', fixed: '4.17.21' }] }],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('Not Found', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('scaVulnerabilityToIssue', () => {
  it('maps a vulnerability to a blocking inline security issue', () => {
    const issue = scaVulnerabilityToIssue(makeVuln());
    expect(issue.type).toBe('issue');
    expect(issue.severity).toBe('critical');
    expect(issue.file).toBe('package-lock.json');
    expect(issue.line).toBe(12);
    expect(issue.inline).toBe(true);
    expect(issue.confidence).toBe('high');
    expect(issue.category).toBe('security');
    expect(issue.message).toContain('CVE-2021-23337');
    expect(issue.message).toContain('lodash@4.17.19');
    expect(issue.message).toContain('CVSS: 9.8');
    expect(issue.message).toContain('Fixed version: 4.17.21');
    expect(issue.suggestion).toContain('Upgrade lodash to 4.17.21');
  });

  it('falls back to the advisory id for GHSA-only advisories', () => {
    const issue = scaVulnerabilityToIssue(makeVuln({ cveIds: [] }));
    expect(issue.message).toContain('GHSA-lodash');
  });

  it('omits the CVSS fragment when no score is present', () => {
    const issue = scaVulnerabilityToIssue(makeVuln({ cvssScore: undefined }));
    expect(issue.message).not.toContain('CVSS:');
  });
});

describe('runSCAScan', () => {
  const packageLockPatch = [
    '@@ -5,7 +5,7 @@',
    '   "dependencies": {',
    '     "node_modules/lodash": {',
    '-      "version": "4.17.19",',
    '+      "version": "4.17.19",',
    '       "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.19.tgz",',
    '       "integrity": "sha512-abc"',
    '     }',
    '   }',
  ].join('\n');

  it('returns vulnerability issues at or above the severity floor', async () => {
    const issues = await runSCAScan(
      [changedFile('package-lock.json', packageLockPatch)],
      process.cwd(),
      makeOptions({ fetchImpl: osvStub('critical') }),
      noopLogger,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('critical');
    expect(issues[0].message).toContain('CVE-2021-23337');
  });

  it('drops findings below the configured minimum severity', async () => {
    const issues = await runSCAScan(
      [changedFile('package-lock.json', packageLockPatch)],
      process.cwd(),
      makeOptions({ minSeverity: 'important', fetchImpl: osvStub('minor') }),
      noopLogger,
    );
    expect(issues).toEqual([]);
  });

  it('returns an empty array when the scan is disabled', async () => {
    const issues = await runSCAScan(
      [changedFile('package-lock.json', packageLockPatch)],
      process.cwd(),
      makeOptions({ enabled: false, fetchImpl: osvStub('critical') }),
      noopLogger,
    );
    expect(issues).toEqual([]);
  });

  it('returns an empty array when no supported lock files changed', async () => {
    const issues = await runSCAScan(
      [changedFile('src/foo.ts', '+const x = 1;')],
      process.cwd(),
      makeOptions({ fetchImpl: osvStub('critical') }),
      noopLogger,
    );
    expect(issues).toEqual([]);
  });

  it('degrades gracefully to an empty array when the OSV call fails', async () => {
    const failingFetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const issues = await runSCAScan(
      [changedFile('package-lock.json', packageLockPatch)],
      process.cwd(),
      makeOptions({ fetchImpl: failingFetch }),
      noopLogger,
    );
    expect(issues).toEqual([]);
  });

  it('deduplicates identical advisories for the same dependency', async () => {
    const issues = await runSCAScan(
      [changedFile('package-lock.json', packageLockPatch)],
      process.cwd(),
      makeOptions({ fetchImpl: osvStub('critical') }),
      noopLogger,
    );
    const unique: ReviewIssue[] = [];
    for (const issue of issues) {
      if (!unique.some((u) => u.message === issue.message)) unique.push(issue);
    }
    expect(unique).toEqual(issues);
  });
});
