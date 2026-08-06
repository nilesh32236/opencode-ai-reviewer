import { describe, expect, it, vi } from 'vitest';
import {
  OSV_API_BASE,
  buildBatchQueries,
  cvssV3BaseScore,
  extractCveIds,
  extractFixedVersion,
  queryOSV,
  queryOSVWithStatus,
  resolveSeverity,
  severityFromCvss,
  severityFromOsvLabel,
} from '../../src/sca/osv-client.js';
import type { OSVQueryBatchResponse, OSVVulnerability } from '../../src/sca/types.js';
import type { SCADependency, SCAVulnerability } from '../../src/types/index.js';

function dep(partial: Partial<SCADependency> = {}): SCADependency {
  return {
    file: 'yarn.lock',
    line: 12,
    name: 'lodash',
    version: '4.17.19',
    ecosystem: 'npm',
    ...partial,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('severityFromCvss', () => {
  it('maps CVSS thresholds to project severities', () => {
    expect(severityFromCvss(9.8)).toBe('critical');
    expect(severityFromCvss(9.0)).toBe('critical');
    expect(severityFromCvss(7.5)).toBe('important');
    expect(severityFromCvss(7.0)).toBe('important');
    expect(severityFromCvss(4.5)).toBe('minor');
    expect(severityFromCvss(0.0)).toBe('minor');
  });
});

describe('severityFromOsvLabel', () => {
  it('maps OSV labels case-insensitively', () => {
    expect(severityFromOsvLabel('CRITICAL')).toBe('critical');
    expect(severityFromOsvLabel('high')).toBe('important');
    expect(severityFromOsvLabel('IMPORTANT')).toBe('important');
    expect(severityFromOsvLabel('MODERATE')).toBe('minor');
    expect(severityFromOsvLabel('low')).toBe('minor');
  });

  it('returns undefined for unknown labels', () => {
    expect(severityFromOsvLabel('whatever')).toBeUndefined();
    expect(severityFromOsvLabel(undefined)).toBeUndefined();
  });
});

describe('resolveSeverity', () => {
  it('uses a numeric CVSS score when present', () => {
    expect(
      resolveSeverity({
        id: 'GHSA-1',
        severity: [{ type: 'CVSS_V3', score: '9.8' }],
      }),
    ).toEqual({ severity: 'critical', cvssScore: 9.8 });
  });

  it('parses a CVSS v3 vector string for a critical advisory', () => {
    const vuln: OSVVulnerability = {
      id: 'GHSA-crit',
      severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H' }],
    };
    expect(resolveSeverity(vuln).severity).toBe('critical');
  });

  it('parses a CVSS v3 vector string for an important advisory', () => {
    const vuln: OSVVulnerability = {
      id: 'GHSA-imp',
      severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N' }],
    };
    const { severity, cvssScore } = resolveSeverity(vuln);
    expect(severity).toBe('important');
    expect(cvssScore).toBeGreaterThanOrEqual(7.0);
    expect(cvssScore).toBeLessThan(9.0);
  });

  it('falls back to the database-specific severity label', () => {
    expect(
      resolveSeverity({
        id: 'GHSA-2',
        database_specific: { severity: 'MODERATE' },
      }),
    ).toEqual({ severity: 'minor' });
  });

  it('defaults to minor when neither score nor label is available', () => {
    expect(resolveSeverity({ id: 'GHSA-3' })).toEqual({ severity: 'minor' });
  });
});

describe('cvssV3BaseScore', () => {
  it.each([
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 9.8],
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N', 7.5],
    ['CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:H/I:N/A:N', 5.3],
    ['CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H', 9.9],
    ['CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N', 1.8],
    ['CVSS:3.1/AV:N/AC:H/PR:H/UI:N/S:U/C:N/I:N/A:H', 4.4],
    ['CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 9.8],
  ])('computes the exact base score for %s', (vector, expected) => {
    expect(cvssV3BaseScore(vector)).toBe(expected);
  });

  it('returns undefined for a non-CVSS-v3 vector', () => {
    expect(cvssV3BaseScore('not-a-vector')).toBeUndefined();
    expect(cvssV3BaseScore('CVSS:4.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBeUndefined();
  });
});

describe('buildBatchQueries', () => {
  it('maps each dependency to an OSV query preserving the ecosystem', () => {
    const payload = buildBatchQueries([
      dep(),
      dep({ name: 'requests', version: '2.31.0', ecosystem: 'PyPI' }),
      dep({ name: 'github.com/foo/bar', version: 'v1.2.3', ecosystem: 'Go' }),
      dep({ name: 'nokogiri', version: '1.14.0', ecosystem: 'RubyGems' }),
    ]);
    expect(payload.queries).toEqual([
      { package: { ecosystem: 'npm', name: 'lodash' }, version: '4.17.19' },
      { package: { ecosystem: 'PyPI', name: 'requests' }, version: '2.31.0' },
      { package: { ecosystem: 'Go', name: 'github.com/foo/bar' }, version: 'v1.2.3' },
      { package: { ecosystem: 'RubyGems', name: 'nokogiri' }, version: '1.14.0' },
    ]);
  });
});

describe('extractCveIds', () => {
  it('returns only CVE-shaped aliases', () => {
    expect(extractCveIds({ id: 'GHSA-1', aliases: ['CVE-2021-23337', 'GHSA-xxxx'] })).toEqual([
      'CVE-2021-23337',
    ]);
  });

  it('returns an empty array for GHSA-only advisories (caller falls back to the id)', () => {
    expect(extractCveIds({ id: 'GHSA-1', aliases: ['GHSA-xxxx'] })).toEqual([]);
    expect(extractCveIds({ id: 'GHSA-1' })).toEqual([]);
  });
});

describe('extractFixedVersion', () => {
  it('prefers the affected entry matching the dependency package', () => {
    const vuln: OSVVulnerability = {
      id: 'GHSA-1',
      affected: [
        {
          package: { name: 'other' },
          ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0', fixed: '99.0.0' }] }],
        },
        {
          package: { name: 'lodash' },
          ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '4.17.0', fixed: '4.17.21' }] }],
        },
      ],
    };
    expect(extractFixedVersion(vuln, dep())).toBe('4.17.21');
  });

  it('picks the lowest fixed version newer than the current version', () => {
    const vuln: OSVVulnerability = {
      id: 'GHSA-1',
      affected: [
        {
          package: { name: 'lodash' },
          ranges: [
            { type: 'ECOSYSTEM', events: [{ introduced: '4.17.0', fixed: '4.17.21' }] },
            { type: 'ECOSYSTEM', events: [{ introduced: '4.17.20', fixed: '4.17.24' }] },
          ],
        },
      ],
    };
    expect(extractFixedVersion(vuln, dep({ version: '4.17.19' }))).toBe('4.17.21');
  });

  it('returns undefined when no fixed version is newer than the current version', () => {
    const vuln: OSVVulnerability = {
      id: 'GHSA-1',
      affected: [
        {
          package: { name: 'lodash' },
          ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0', fixed: '4.17.21' }] }],
        },
      ],
    };
    // 4.17.21 is not newer than the declared 5.0.0, so reporting it would
    // recommend a downgrade; the caller falls back to generic upgrade guidance.
    expect(extractFixedVersion(vuln, dep({ version: '5.0.0' }))).toBeUndefined();
  });

  it('uses package-less affected entries when no named match exists', () => {
    const vuln: OSVVulnerability = {
      id: 'GHSA-1',
      affected: [
        { ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0', fixed: '5.0.2' }] }] },
      ],
    };
    expect(extractFixedVersion(vuln, dep())).toBe('5.0.2');
  });

  it('returns undefined when no fixed event exists', () => {
    expect(extractFixedVersion({ id: 'GHSA-1', affected: [] }, dep())).toBeUndefined();
  });
});

describe('queryOSV', () => {
  it('hydrates matched advisories, uses fetchImpl, and honors a tiny batch size', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/querybatch')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as OSVQueryBatchResponse;
        const results = (body.queries ?? []).map((q: { package: { name: string } }) => {
          if (q.package.name === 'lodash') {
            return { vulns: [{ id: 'GHSA-lodash', modified: '2024-01-01T00:00:00Z' }] };
          }
          if (q.package.name === 'express') {
            return { vulns: [{ id: 'GHSA-express', modified: '2024-01-01T00:00:00Z' }] };
          }
          return {};
        });
        return jsonResponse({ results });
      }
      if (url.includes('/v1/vulns/')) {
        const id = decodeURIComponent(url.split('/v1/vulns/')[1]);
        const vulns: Record<string, OSVVulnerability> = {
          'GHSA-lodash': {
            id: 'GHSA-lodash',
            aliases: ['CVE-2021-23337'],
            summary: 'Prototype pollution in lodash',
            severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
            affected: [
              {
                package: { name: 'lodash' },
                ranges: [
                  { type: 'ECOSYSTEM', events: [{ introduced: '4.0.0', fixed: '4.17.21' }] },
                ],
              },
            ],
          },
          'GHSA-express': {
            id: 'GHSA-express',
            summary: 'Vulnerability in express',
            database_specific: { severity: 'HIGH' },
            affected: [],
          },
        };
        const vuln = vulns[id];
        if (!vuln) return new Response('Not Found', { status: 404 });
        return jsonResponse(vuln);
      }
      return new Response('Not Found', { status: 404 });
    }) as unknown as typeof fetch;

    const results = await queryOSV(
      [dep(), dep({ name: 'express', version: '4.18.1', file: 'package-lock.json', line: 4 })],
      { fetchImpl, maxBatchQueries: 1, concurrency: 2 },
    );

    // maxBatchQueries 1 forces two separate querybatch requests (clamped to >= 1).
    const queryBatchCalls = fetchImpl.mock.calls.filter(([u]) =>
      String(u).endsWith('/v1/querybatch'),
    );
    expect(queryBatchCalls).toHaveLength(2);

    const byName = new Map(results.map((r) => [r.dependency.name, r]));
    const lodash = byName.get('lodash');
    expect(lodash).toBeDefined();
    expect(lodash?.cveIds).toEqual(['CVE-2021-23337']);
    expect(lodash?.severity).toBe('critical');
    expect(lodash?.cvssScore).toBeGreaterThanOrEqual(9.0);
    expect(lodash?.fixedVersion).toBe('4.17.21');
    expect(lodash?.summary).toContain('lodash');

    const express = byName.get('express');
    expect(express?.severity).toBe('important');
  });

  it('drops advisories whose hydration returns 404', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/querybatch')) {
        return jsonResponse({
          results: [{ vulns: [{ id: 'GHSA-gone', modified: '2024-01-01T00:00:00Z' }] }],
        });
      }
      if (url.includes('/v1/vulns/')) {
        return new Response('Not Found', { status: 404 });
      }
      return new Response('Not Found', { status: 404 });
    }) as unknown as typeof fetch;

    const results = await queryOSV([dep()], { fetchImpl });
    expect(results).toEqual([]);
  });

  it('returns no matches when the batch response has no vulns', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/v1/querybatch')) {
        return jsonResponse({ results: [{}] });
      }
      return new Response('Not Found', { status: 404 });
    }) as unknown as typeof fetch;
    expect(await queryOSV([dep()], { fetchImpl })).toEqual([]);
  });

  it('keeps other findings when a single advisory hydration fails', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/querybatch')) {
        return jsonResponse({
          results: [
            { vulns: [{ id: 'GHSA-good', modified: '2024-01-01T00:00:00Z' }] },
            { vulns: [{ id: 'GHSA-broken', modified: '2024-01-01T00:00:00Z' }] },
          ],
        });
      }
      if (url.includes('/v1/vulns/GHSA-good')) {
        return jsonResponse({ id: 'GHSA-good', summary: 'ok advisory' });
      }
      if (url.includes('/v1/vulns/GHSA-broken')) {
        return new Response('Internal Server Error', { status: 500 });
      }
      return new Response('Not Found', { status: 404 });
    }) as unknown as typeof fetch;

    const results = await queryOSV(
      [dep({ name: 'good' }), dep({ name: 'broken', file: 'package-lock.json', line: 4 })],
      { fetchImpl, concurrency: 2 },
    );

    // The broken hydration is skipped, but the valid advisory still surfaces.
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('GHSA-good');
  });

  it('calls the real API base for querybatch and vulns endpoints', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) => {
      return jsonResponse({ results: [{}] });
    }) as unknown as typeof fetch;
    await queryOSV([dep()], { fetchImpl });
    const urls = fetchImpl.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u === `${OSV_API_BASE}/v1/querybatch`)).toBe(true);
  });

  it('clamps an oversized maxBatchQueries to the OSV querybatch cap', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/v1/querybatch')) {
        return jsonResponse({ results: [{ vulns: [] }] });
      }
      return jsonResponse({ results: [{}] });
    }) as unknown as typeof fetch;

    const manyDeps = Array.from({ length: 2500 }, (_, i) =>
      dep({ name: `pkg-${i}`, version: '1.0.0', file: 'package-lock.json', line: i + 1 }),
    );
    await queryOSV(manyDeps, { fetchImpl, maxBatchQueries: 1_000_000 });

    const queryBatchCalls = fetchImpl.mock.calls.filter(([u]) =>
      String(u).endsWith('/v1/querybatch'),
    );
    // 2500 deps / 1000-per-batch cap = 3 requests, never 1 (huge batch) or 2500.
    expect(queryBatchCalls).toHaveLength(3);
  });

  it('honors an osvBaseUrl override for air-gapped mirrors', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) => {
      return jsonResponse({ results: [{}] });
    }) as unknown as typeof fetch;
    await queryOSV([dep()], { fetchImpl, osvBaseUrl: 'http://osv.internal:8080' });
    const urls = fetchImpl.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u === 'http://osv.internal:8080/v1/querybatch')).toBe(true);
  });

  it('reports an aborted scan and preserves no findings when nothing resolved', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) => {
      throw new Error('should not be reached before the deadline fires');
    }) as unknown as typeof fetch;
    const { vulnerabilities, aborted } = await queryOSVWithStatus([dep()], {
      fetchImpl,
      signal: controller.signal,
    });
    expect(aborted).toBe(true);
    expect(vulnerabilities).toEqual([]);
  });
});

describe('SCAVulnerability round-trip', () => {
  it('exposes the cvssScore on the vulnerability record', () => {
    const vuln: SCAVulnerability = {
      dependency: dep(),
      id: 'GHSA-lodash',
      cveIds: ['CVE-2021-23337'],
      summary: 'Prototype pollution',
      severity: 'critical',
      cvssScore: 9.8,
      references: [],
    };
    expect(vuln.cvssScore).toBe(9.8);
  });
});
