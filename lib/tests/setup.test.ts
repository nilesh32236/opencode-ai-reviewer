import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockResolveOpenCodePath,
  mockRunOpenCode,
  mockCheckHealth,
  mockExecFileSync,
  mockGetRepositoryPermissions,
} = vi.hoisted(() => {
  const _mockResolveOpenCodePath = vi.fn().mockResolvedValue('/usr/local/bin/opencode');
  const _mockRunOpenCode = vi.fn().mockResolvedValue({
    success: true,
    output: 'ok',
    durationMs: 100,
    tokensUsed: 0,
  });
  const _mockCheckHealth = vi.fn().mockResolvedValue({
    available: true,
    compatible: true,
    version: { raw: 'v1.2.3', major: 1, minor: 2, patch: 3, prerelease: null },
    message: 'OpenCode v1.2.3 is available and compatible',
  });
  const _mockExecFileSync = vi.fn().mockReturnValue('opencode v1.2.3');
  const _mockGetRepositoryPermissions = vi.fn().mockResolvedValue({
    admin: false,
    push: true,
    pull: true,
  });
  return {
    mockResolveOpenCodePath: _mockResolveOpenCodePath,
    mockRunOpenCode: _mockRunOpenCode,
    mockCheckHealth: _mockCheckHealth,
    mockExecFileSync: _mockExecFileSync,
    mockGetRepositoryPermissions: _mockGetRepositoryPermissions,
  };
});

vi.mock('../src/opencode.js', () => ({
  resolveOpenCodePath: mockResolveOpenCodePath,
  runOpenCode: mockRunOpenCode,
  checkHealth: mockCheckHealth,
}));

vi.mock('../src/utils/github.js', () => ({
  GitHubHelper: class {
    constructor(
      public token: string,
      public repo: string,
      public apiUrl?: string,
    ) {}
    getRepositoryPermissions = mockGetRepositoryPermissions;
  },
}));

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  addPath: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock('@actions/io', () => ({
  which: vi.fn().mockResolvedValue('/usr/local/bin/opencode'),
}));

import { SetupEngine } from '../src/setup/engine.js';
import { DEFAULT_CONFIG } from '../src/types/index.js';

function makeConfig(overrides: Partial<typeof DEFAULT_CONFIG> = {}): typeof DEFAULT_CONFIG {
  return { ...DEFAULT_CONFIG, ...overrides };
}

describe('SetupEngine', () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-setup-test-'));
    for (const key of [
      'GITHUB_TOKEN',
      'INPUT_GITHUB_TOKEN',
      'OPENAI_API_KEY',
      'INPUT_OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'INPUT_ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'INPUT_GEMINI_API_KEY',
      'OPENCODE_API_KEY',
      'INPUT_OPENCODE_API_KEY',
      'AZURE_OPENAI_API_KEY',
      'AZURE_OPENAI_ENDPOINT',
      'AZURE_RESOURCE_NAME',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_PROFILE',
      'AWS_BEARER_TOKEN_BEDROCK',
      'AWS_WEB_IDENTITY_TOKEN_FILE',
      'AWS_ROLE_ARN',
      'OLLAMA_MODEL',
      'LLM_BASE_URL',
      'LLM_API_KEY',
      'APP_ID',
      'PRIVATE_KEY',
      'PRIVATE_KEY_PATH',
      'APP_PRIVATE_KEY',
    ]) {
      delete process.env[key];
    }
    mockResolveOpenCodePath.mockResolvedValue('/usr/local/bin/opencode');
    mockExecFileSync.mockReturnValue('opencode v1.2.3');
    mockRunOpenCode.mockResolvedValue({
      success: true,
      output: 'ok',
      durationMs: 100,
      tokensUsed: 0,
    });
    mockCheckHealth.mockResolvedValue({
      available: true,
      compatible: true,
      version: { raw: 'v1.2.3', major: 1, minor: 2, patch: 3, prerelease: null },
      message: 'OpenCode v1.2.3 is available and compatible',
    });
    mockGetRepositoryPermissions.mockResolvedValue({ admin: false, push: true, pull: true });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe('checkSecrets', () => {
    it('passes with GitHub token and default opencode model (no provider key needed)', () => {
      process.env.GITHUB_TOKEN = 'token';
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      const check = engine.checkSecrets();
      expect(check.status).toBe('pass');
      expect(check.name).toBe('Secrets');
    });

    it('passes when a provider API key is present', () => {
      process.env.GITHUB_TOKEN = 'token';
      process.env.OPENAI_API_KEY = 'sk-...';
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      expect(engine.checkSecrets().status).toBe('pass');
    });

    it('fails when the GitHub token is missing', () => {
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      const check = engine.checkSecrets();
      expect(check.status).toBe('fail');
      expect(check.message).toContain('GITHUB_TOKEN');
    });

    it('fails when a non-opencode model is configured without a provider key', () => {
      process.env.GITHUB_TOKEN = 'token';
      const engine = new SetupEngine(makeConfig({ reviewModel: 'gpt-4o' }), {
        workingDirectory: tmpDir,
      });
      const check = engine.checkSecrets();
      expect(check.status).toBe('fail');
      expect(check.message).toContain('provider');
    });

    it('accepts token passed via options', () => {
      const engine = new SetupEngine(makeConfig(), {
        workingDirectory: tmpDir,
        githubToken: 'opt-token',
      });
      expect(engine.checkSecrets().status).toBe('pass');
    });

    it('passes with a GitHub App credential instead of a token', () => {
      process.env.APP_ID = '12345';
      process.env.PRIVATE_KEY =
        '-----BEGIN RSA PRIVATE KEY-----\nfoo\n-----END RSA PRIVATE KEY-----';
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      const check = engine.checkSecrets();
      expect(check.status).toBe('pass');
      expect(check.details).toContain('GitHub App');
    });

    it('fails when APP_ID is set but the private key is missing or invalid', () => {
      process.env.APP_ID = '12345';
      process.env.PRIVATE_KEY = 'not-a-pem';
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      const check = engine.checkSecrets();
      expect(check.status).toBe('fail');
      expect(check.message).toContain('private key');
    });
  });

  describe('checkPermissions', () => {
    it('passes when the token has read/write access to the repo', async () => {
      const engine = new SetupEngine(makeConfig(), {
        workingDirectory: tmpDir,
        githubToken: 'token',
        repo: 'owner/repo',
      });
      const check = await engine.checkPermissions();
      expect(check.status).toBe('pass');
      expect(check.message).toContain('Repository access verified');
    });

    it('passes when the token can read but cannot push to the repo (fine-grained scopes)', async () => {
      mockGetRepositoryPermissions.mockResolvedValue({ admin: false, push: false, pull: true });
      const engine = new SetupEngine(makeConfig(), {
        workingDirectory: tmpDir,
        githubToken: 'token',
        repo: 'owner/repo',
      });
      const check = await engine.checkPermissions();
      expect(check.status).toBe('pass');
      expect(check.details).toContain('read-only');
    });

    it('fails when the token cannot read the repo', async () => {
      mockGetRepositoryPermissions.mockResolvedValue({ admin: false, push: false, pull: false });
      const engine = new SetupEngine(makeConfig(), {
        workingDirectory: tmpDir,
        githubToken: 'token',
        repo: 'owner/repo',
      });
      const check = await engine.checkPermissions();
      expect(check.status).toBe('fail');
      expect(check.message).toContain('cannot read');
    });

    it('fails when no GitHub token is present', async () => {
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      const check = await engine.checkPermissions();
      expect(check.status).toBe('fail');
      expect(check.message).toContain('GITHUB_TOKEN');
    });

    it('passes gracefully when no repo probe is requested', async () => {
      process.env.GITHUB_TOKEN = 'token';
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      const check = await engine.checkPermissions();
      expect(check.status).toBe('pass');
    });

    it('passes with a GitHub App credential and no token', async () => {
      process.env.APP_ID = '12345';
      process.env.PRIVATE_KEY =
        '-----BEGIN RSA PRIVATE KEY-----\nfoo\n-----END RSA PRIVATE KEY-----';
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      const check = await engine.checkPermissions();
      expect(check.status).toBe('pass');
      expect(check.details).toContain('GitHub App');
    });

    it('fails when APP_ID is set but the private key is missing', async () => {
      process.env.APP_ID = '12345';
      process.env.GITHUB_TOKEN = 'token';
      const engine = new SetupEngine(makeConfig(), {
        workingDirectory: tmpDir,
        githubToken: 'token',
      });
      const check = await engine.checkPermissions();
      expect(check.status).toBe('fail');
      expect(check.message).toContain('private key');
    });

    it('fails when APP_ID is set but the private key is not PEM', async () => {
      process.env.APP_ID = '12345';
      process.env.PRIVATE_KEY = 'not-a-pem-key';
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      const check = await engine.checkPermissions();
      expect(check.status).toBe('fail');
      expect(check.message).toContain('private key');
    });

    it('degrades gracefully when the GitHub API is unreachable', async () => {
      mockGetRepositoryPermissions.mockRejectedValue(
        new Error('fetch failed: getaddrinfo ENOTFOUND api.github.com'),
      );
      const engine = new SetupEngine(makeConfig(), {
        workingDirectory: tmpDir,
        githubToken: 'token',
        repo: 'owner/repo',
      });
      const check = await engine.checkPermissions();
      expect(check.status).toBe('skip');
      expect(check.message).toContain('unreachable');
      const result = await engine.runAll();
      expect(result.checks).toContainEqual(expect.objectContaining({ name: 'Permissions' }));
      expect(result.checks.find((c) => c.name === 'Permissions')?.status).toBe('skip');
    });
  });

  describe('checkOpenCodeCLI', () => {
    it('passes when opencode is at an acceptable version', async () => {
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      const check = await engine.checkOpenCodeCLI();
      expect(check.status).toBe('pass');
      expect(check.message).toContain('v1.2.3');
      expect(mockCheckHealth).toHaveBeenCalledWith(
        expect.objectContaining({ binPath: '/usr/local/bin/opencode', minimumVersion: '1.1.1' }),
      );
    });

    it('fails when the version is below the minimum', async () => {
      mockCheckHealth.mockResolvedValue({
        available: true,
        compatible: false,
        version: { raw: 'v1.0.0', major: 1, minor: 0, patch: 0, prerelease: null },
        message: 'OpenCode v1.0.0 is installed but version 1.1.1+ is required.',
      });
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      const check = await engine.checkOpenCodeCLI();
      expect(check.status).toBe('fail');
      expect(check.message).toContain('minimum');
    });

    it('honors a custom minimum version', async () => {
      mockCheckHealth.mockResolvedValue({
        available: true,
        compatible: true,
        version: { raw: 'v1.0.0', major: 1, minor: 0, patch: 0, prerelease: null },
        message: 'OpenCode v1.0.0 is available and compatible',
      });
      const engine = new SetupEngine(makeConfig(), {
        workingDirectory: tmpDir,
        minimumOpenCodeVersion: '0.9.0',
      });
      const check = await engine.checkOpenCodeCLI();
      expect(check.status).toBe('pass');
      expect(mockCheckHealth).toHaveBeenCalledWith(
        expect.objectContaining({ minimumVersion: '0.9.0' }),
      );
    });

    it('fails when the binary cannot be resolved', async () => {
      mockResolveOpenCodePath.mockRejectedValue(new Error('download failed'));
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      const check = await engine.checkOpenCodeCLI();
      expect(check.status).toBe('fail');
      expect(check.message).toContain('download');
    });

    it('fails when the minimum version is not a valid semantic version', async () => {
      const engine = new SetupEngine(makeConfig(), {
        workingDirectory: tmpDir,
        minimumOpenCodeVersion: 'latest',
      });
      const check = await engine.checkOpenCodeCLI();
      expect(check.status).toBe('fail');
      expect(check.message).toContain('minimumOpenCodeVersion');
      expect(mockCheckHealth).not.toHaveBeenCalled();
    });

    it('treats a pre-release as below the release (1.1.1-rc.1 < 1.1.1)', async () => {
      mockCheckHealth.mockResolvedValue({
        available: true,
        compatible: false,
        version: { raw: 'v1.1.1-rc.1', major: 1, minor: 1, patch: 1, prerelease: 'rc.1' },
        message: 'OpenCode v1.1.1-rc.1 is installed but version 1.1.1+ is required.',
      });
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      const check = await engine.checkOpenCodeCLI();
      expect(check.status).toBe('fail');
      expect(check.message).toContain('minimum');
    });

    it('passes a pre-release when the base version is above the minimum', async () => {
      mockCheckHealth.mockResolvedValue({
        available: true,
        compatible: true,
        version: { raw: 'v1.2.0-rc.1', major: 1, minor: 2, patch: 0, prerelease: 'rc.1' },
        message: 'OpenCode v1.2.0-rc.1 is available and compatible',
      });
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      const check = await engine.checkOpenCodeCLI();
      expect(check.status).toBe('pass');
    });

    it('fails when the version command times out', async () => {
      mockCheckHealth.mockResolvedValue({
        available: true,
        compatible: false,
        version: null,
        message:
          'OpenCode binary found at /usr/local/bin/opencode but version check failed: timed out',
      });
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      const check = await engine.checkOpenCodeCLI();
      expect(check.status).toBe('fail');
      expect(check.message).toContain('timed out');
    });

    it('fails when the binary is not available', async () => {
      mockCheckHealth.mockResolvedValue({
        available: false,
        compatible: false,
        version: null,
        message: 'OpenCode CLI not found.',
      });
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      const check = await engine.checkOpenCodeCLI();
      expect(check.status).toBe('fail');
      expect(check.message).toContain('not available');
    });
  });

  describe('checkModelConnectivity', () => {
    it('passes when the model probe succeeds', async () => {
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      const check = await engine.checkModelConnectivity();
      expect(check.status).toBe('pass');
      expect(check.message).toContain('probed');
    });

    it('fails when the model probe returns an error', async () => {
      mockRunOpenCode.mockResolvedValue({
        success: false,
        output: 'HTTP 401 Unauthorized',
        durationMs: 100,
        tokensUsed: 0,
      });
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      const check = await engine.checkModelConnectivity();
      expect(check.status).toBe('fail');
      expect(check.message).toContain('failed');
    });

    it('probes all distinct configured models when probeAllModels is set', async () => {
      const engine = new SetupEngine(makeConfig({ fixModel: 'claude-3-5-sonnet' }), {
        workingDirectory: tmpDir,
        probeAllModels: true,
      });
      await engine.checkModelConnectivity();
      const probedModels = mockRunOpenCode.mock.calls.map((call) => call[1]?.model);
      expect(probedModels).toContain(DEFAULT_CONFIG.reviewModel);
      expect(probedModels).toContain('claude-3-5-sonnet');
    });

    it('redacts secret patterns from probe output in the report', async () => {
      mockRunOpenCode.mockResolvedValue({
        success: false,
        output: 'Incorrect API key provided: sk-abc123def456ghi789jkl012mno345',
        durationMs: 100,
        tokensUsed: 0,
      });
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      const check = await engine.checkModelConnectivity();
      expect(check.status).toBe('fail');
      expect(check.details).not.toContain('sk-abc123def456ghi789jkl012mno345');
      expect(check.details).toContain('sk-***');
    });
  });

  describe('checkConfig', () => {
    it('passes when no config file exists', async () => {
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      const check = await engine.checkConfig();
      expect(check.status).toBe('pass');
      expect(check.message).toContain('No config');
    });

    it('passes with a valid config file', async () => {
      fs.writeFileSync(
        path.join(tmpDir, '.opencode-reviewer.yml'),
        'review:\n  systemPrompt: "Be thorough"\nfix:\n  maxIterations: 5\n',
      );
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      const check = await engine.checkConfig();
      expect(check.status).toBe('pass');
      expect(check.message).toContain('valid');
    });

    it('fails when the config file is invalid', async () => {
      fs.writeFileSync(path.join(tmpDir, '.opencode-reviewer.yml'), 'invalid: [yaml: broken');
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      const check = await engine.checkConfig();
      expect(check.status).toBe('fail');
      expect(check.message).toContain('invalid');
    });

    it('fails when a referenced audit path does not exist', async () => {
      fs.writeFileSync(
        path.join(tmpDir, '.opencode-reviewer.yml'),
        'audit:\n  promptsDir: "does-not-exist"\n',
      );
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      const check = await engine.checkConfig();
      expect(check.status).toBe('fail');
      expect(check.message).toContain('does not exist');
    });

    it('passes when referenced audit paths exist', async () => {
      fs.mkdirSync(path.join(tmpDir, '.audit-prompts'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.audit-prompts', 'security.md'), 'probe');
      fs.writeFileSync(
        path.join(tmpDir, '.opencode-reviewer.yml'),
        'audit:\n  promptsDir: ".audit-prompts"\n  categories: ["security"]\n  targetDirs: ["src"]\n',
      );
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      const check = await engine.checkConfig();
      expect(check.status).toBe('pass');
    });

    it('fails when a targetDirs entry does not exist', async () => {
      fs.writeFileSync(
        path.join(tmpDir, '.opencode-reviewer.yml'),
        'audit:\n  targetDirs: ["missing-dir"]\n',
      );
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      const check = await engine.checkConfig();
      expect(check.status).toBe('fail');
      expect(check.message).toContain('targetDirs');
    });

    it('fails when a targetDirs entry is a file, not a directory', async () => {
      fs.writeFileSync(path.join(tmpDir, 'not-a-dir.txt'), 'file');
      fs.writeFileSync(
        path.join(tmpDir, '.opencode-reviewer.yml'),
        'audit:\n  targetDirs: ["not-a-dir.txt"]\n',
      );
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      const check = await engine.checkConfig();
      expect(check.status).toBe('fail');
      expect(check.message).toContain('targetDirs');
    });
  });

  describe('runAll + formatReport', () => {
    it('returns a SetupResult with all checks and pass overall', async () => {
      process.env.GITHUB_TOKEN = 'token';
      const engine = new SetupEngine(makeConfig(), {
        workingDirectory: tmpDir,
        githubToken: 'token',
        repo: 'owner/repo',
      });
      const result = await engine.runAll();
      expect(result.checks.length).toBe(5);
      expect(result.overall).toBe('pass');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.timestamp).toBe('number');
    });

    it('computes overall fail when any check fails', async () => {
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      const result = await engine.runAll();
      expect(result.overall).toBe('fail');
    });

    it('generates a well-formed markdown report', async () => {
      process.env.GITHUB_TOKEN = 'token';
      const engine = new SetupEngine(makeConfig(), {
        workingDirectory: tmpDir,
        githubToken: 'token',
        repo: 'owner/repo',
      });
      const result = await engine.runAll();
      const report = engine.formatReport(result);
      expect(report).toContain('Setup Validation Report');
      expect(report).toContain('Overall: ✅ PASS');
      expect(report).toContain('Secrets');
      expect(report).toContain('Permissions');
      expect(report).toContain('OpenCode CLI');
      expect(report).toContain('Model Connectivity');
      expect(report).toContain('Config');
    });

    it('reports failures in the markdown report', async () => {
      const engine = new SetupEngine(makeConfig(), { workingDirectory: tmpDir });
      const result = await engine.runAll();
      const report = engine.formatReport(result);
      expect(report).toContain('Overall: ❌ FAIL');
    });
  });
});
