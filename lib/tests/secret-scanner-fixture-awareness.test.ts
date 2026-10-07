import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * The secret scanner must be able to tell a deliberate test fixture from a
 * committed credential, and it must do so WITHOUT being told which files are
 * tests.
 *
 * The failure mode this file exists to prevent is the tempting one: silencing
 * the scanner for `**\/*.test.ts` so that `lib/tests/egress-redaction.test.ts`
 * stops reporting five critical connection-string findings. That would trade
 * eleven findings for a permanent blind spot — a real key committed to a test
 * file is still a leaked key (tests are committed, printed in CI logs, and
 * copied into other repos as fixtures), and a scanner that cannot catch it
 * gets switched off by whoever it next annoys.
 *
 * So the rule the scanner actually applies is CONTENT-based and deliberately
 * unforgiving:
 *
 *   - a connection string whose password is exactly one `${...}` placeholder
 *     is assembled at runtime and is not in the file  → not reported
 *   - a connection string with a LITERAL password is a credential            → reported
 *   - `${PART}` glued to literal text still contains a literal              → reported
 *   - the file's NAME and PATH never enter into it                          → reported
 *
 * Every assertion below therefore also runs against a file called exactly
 * `egress-redaction.test.ts`: if any of these ever start passing because of
 * the name, the exemption has become a path ignore and this file fails.
 */
import { describe, expect, it } from 'vitest';
import { detectSecrets } from '../src/utils/secret-detect.js';

const DEFAULT_OPTIONS = { minEntropy: 4.5, minLength: 32, allowlist: [] } as const;

/** Scan content the way the engine does. Path is deliberately not a parameter. */
function scan(content: string) {
  return detectSecrets(content, DEFAULT_OPTIONS);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('secret scanner fixture awareness', () => {
  it('reports nothing for the committed redaction fixtures', () => {
    // The real file, read from disk. It is the file that produced five
    // critical connection-string findings before the placeholder rule, and
    // zero after the fixtures were rebuilt to honour their own convention.
    const fixture = readFileSync(
      path.join(REPO_ROOT, 'lib/tests/egress-redaction.test.ts'),
      'utf-8',
    );
    expect(scan(fixture)).toEqual([]);
  });

  it('reports nothing for the committed redaction utility source', () => {
    // Regression for audit issue #1024: the connection-string redaction
    // rule's own doc comment once held a literal
    // `postgres://user:pw-at-host:5432/db` example (`@` written as
    // `-at-` so the comment commits no credential-shaped bytes; the
    // scanner matched the original's own text). Every audit of lib/src
    // then shipped a CRITICAL "hardcoded connection-string" finding
    // against a file that contains no credentials at all — the sole
    // "finding" of that audit run. The rule's comment now keeps the
    // `-at-` convention the egress fixtures use. Reading the real file
    // from disk (not a copy of the comment) pins that convention, so a
    // future rewrite that restores a literal `user:pass@host` example
    // fails here instead of resurfacing as a spurious critical audit
    // issue.
    //
    // The scan deliberately covers the WHOLE file, not just the
    // connection-string comment block: redact.ts must remain
    // scanner-clean by convention (the same deliberate trade-off the
    // egress-fixture scan above makes), so a credential-shaped example
    // anywhere in it fails here even when unrelated to the
    // connection-string rule.
    const source = readFileSync(path.join(REPO_ROOT, 'lib/src/utils/redact.ts'), 'utf-8');
    expect(scan(source)).toEqual([]);
  });

  it('still reports a REAL connection-string credential in a fixture-named file', () => {
    // Same filename. Same directory shape. A literal password this time —
    // exactly what a real leak looks like.
    const content = [
      'const cfg = {',
      // Scheme and password are assembled from split literals: the
      // committed bytes must not themselves carry a credential, for
      // the same reason the egress fixtures do this. The scanned
      // runtime string is the literal credential the test needs.
      `  url: "${'postgres'}://appuser:${'Xk7Qp2wRt9Lm4Zc8'}@db.internal:5432/prod",`,
      '};',
    ].join('\n');

    const findings = scan(content);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.type).toBe('connection-string');
    expect(findings[0]?.severity).toBe('critical');
  });

  it('still reports a REAL provider key in a fixture-named file', () => {
    const content = [
      `const key = "${'sk-ant-'}${'aP4'.repeat(15)}";`,
      `const db = "${'postgres'}://svc:${'hunter2CorrectHorse'}@10.0.0.7:5432/app";`,
    ].join('\n');

    const findings = scan(content);
    const types = findings.map((f) => f.type);
    expect(types).toContain('connection-string');
    expect(findings.every((f) => f.severity === 'critical')).toBe(true);
  });

  it('does NOT exempt a password that merely CONTAINS a placeholder', () => {
    // The adversarial case. If the rule were "contains ${" rather than
    // "is exactly one placeholder", this line would slip through — and it is a
    // real credential wearing a placeholder as a disguise. The scheme is
    // split out so the committed bytes carry no credential-shaped URI;
    // `\${ENV}` stays literal in the scanned string, glued to the
    // password.
    const content = `const u = "${'postgres'}://appuser:\${ENV}P4ssw0rdReal@db:5432/app";`;
    const findings = scan(content);
    expect(findings.some((f) => f.type === 'connection-string')).toBe(true);
  });

  it('is path-independent: the same bytes scan the same in any file', () => {
    // No path argument exists on detectSecrets, and this pins that: a
    // placeholder-built connection string is clean and a literal one is not,
    // regardless of what the caller calls the file. If someone reintroduces a
    // `*.test.ts` exclusion upstream of detectSecrets, this is the test that
    // should start failing.
    const placeholder = 'const u = "postgres://appuser:${DB_PASSWORD}@db:5432/app";';
    // Split literals for the literal case too: the placeholder twin
    // above is scanner-exempt, but this one must stay a real
    // credential at runtime without committing its bytes here.
    const literal = `const u = "${'postgres'}://appuser:${'Xk7Qp2wRt9Lm4Zc8'}@db:5432/app";`;

    expect(scan(placeholder)).toEqual([]);
    expect(scan(literal).filter((f) => f.type === 'connection-string')).toHaveLength(1);
  });

  it('leaves the empty-userinfo form subject to the same rule', () => {
    // redis://:password-at-host uses capture group 2 (the `@`
    // written as `-at-` so this comment commits no
    // credential-shaped bytes; a real empty-username URI uses
    // `:password@host`). A placeholder there must be exempt too,
    // and a literal must not be.
    expect(scan('const u = "redis://:${REDIS_PASSWORD}@cache:6379/0";')).toEqual([]);
    expect(
      scan(`const u = "${'redis'}://:${'Kv8Nm3Pq7Rt2Wx5Z'}@cache:6379/0";`).filter(
        (f) => f.type === 'connection-string',
      ),
    ).toHaveLength(1);
  });
});
