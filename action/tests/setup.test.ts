import { beforeEach, describe, expect, it, vi } from 'vitest';

const { MockSetupEngine, capturedOptions, mockRunAll, mockCore } = vi.hoisted(() => {
  const captured: unknown[] = [];
  const runAll = vi.fn().mockResolvedValue({ overall: 'pass', checks: [] });
  const formatReport = vi.fn().mockReturnValue('# Setup report');
  class MockEngine {
    constructor(_config: unknown, options: unknown) {
      captured.push(options);
    }
    runAll = runAll;
    formatReport = formatReport;
  }
  const core = {
    info: vi.fn(),
    warning: vi.fn(),
    setOutput: vi.fn(),
    setFailed: vi.fn(),
    summary: { addRaw: vi.fn().mockReturnValue({ write: vi.fn().mockResolvedValue(undefined) }) },
  };
  return {
    MockSetupEngine: MockEngine,
    capturedOptions: captured,
    mockRunAll: runAll,
    mockCore: core,
  };
});

vi.mock('@actions/core', () => mockCore);

vi.mock('@actions/github', () => ({
  context: { payload: {} },
}));

vi.mock('@opencode-pr-agent/lib', () => ({
  SetupEngine: MockSetupEngine,
}));

import type { AgentConfig, PlatformAdapter } from '@opencode-pr-agent/lib';
import type { ActionInputs } from '../src/inputs.js';
import { runSetup } from '../src/setup.js';

function makeInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    opencodeVersion: 'latest',
    requireOpencodeChecksum: false,
    probeAllModels: false,
    ...overrides,
  } as ActionInputs;
}

const config = {} as AgentConfig;
const gh = { postOrUpdateComment: vi.fn() } as unknown as PlatformAdapter;

describe('runSetup() requireChecksum forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOptions.length = 0;
  });

  it('forwards requireChecksum: true to the SetupEngine', async () => {
    await runSetup(
      makeInputs({ requireOpencodeChecksum: true }),
      config,
      gh,
      'owner/repo',
      'token',
    );
    expect(mockRunAll).toHaveBeenCalled();
    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]).toMatchObject({ requireChecksum: true });
  });

  it('forwards requireChecksum: false to the SetupEngine', async () => {
    await runSetup(
      makeInputs({ requireOpencodeChecksum: false }),
      config,
      gh,
      'owner/repo',
      'token',
    );
    expect(mockRunAll).toHaveBeenCalled();
    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]).toMatchObject({ requireChecksum: false });
  });
});
