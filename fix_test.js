const fs = require('fs');

const path = 'app/tests/handlers/pr-review.test.ts';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(`
    await handlePRReview(
      42,
      'owner/repo',
      'token',
      DEFAULT_CONFIG,
      new AbortController().signal,
      1,
    );

    const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\\n');
    expect(logged).not.toContain('ghp_1234567890abcdef1234567890abcdef12345678');
    expect(logged).toContain('[REDACTED_GITHUB_TOKEN]');

    errSpy.mockRestore();
  });
`, `
    try {
      await handlePRReview(
        42,
        'owner/repo',
        'token',
        DEFAULT_CONFIG,
        undefined,
        undefined,
      );

      const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\\n');
      expect(logged).not.toContain('ghp_1234567890abcdef1234567890abcdef12345678');
      expect(logged).toContain('[REDACTED_GITHUB_TOKEN]');
    } finally {
      errSpy.mockRestore();
    }
  });
`);

fs.writeFileSync(path, code);
