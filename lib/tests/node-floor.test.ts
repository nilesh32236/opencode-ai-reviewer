import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/types/index.js';
import { Logger } from '../src/utils/logger.js';

const { mockCheckNodeFloor } = vi.hoisted(() => ({
  mockCheckNodeFloor: vi.fn(),
}));

vi.mock('../src/utils/version.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/version.js')>();
  return {
    ...actual,
    checkNodeFloor: (...args: unknown[]) => mockCheckNodeFloor(...args),
  };
});

vi.mock('../src/mcp/client.js', () => ({
  MCPManager: class {
    connect = vi.fn();
    disconnect = vi.fn();
    getLibraryDocs = vi.fn();
  },
}));

import { ReviewEngine } from '../src/engine.js';

function makeAdapter() {
  return {
    getMR: vi.fn(),
    isMR: vi.fn().mockResolvedValue(true),
    getDefaultBranch: vi.fn().mockResolvedValue('main'),
    getIssue: vi.fn(),
    getIssueComments: vi.fn().mockResolvedValue([]),
    getIssueComment: vi.fn(),
    getDiffLines: vi.fn().mockResolvedValue(new Set<string>()),
    getDiffSince: vi.fn().mockResolvedValue(''),
    listReviewComments: vi.fn().mockResolvedValue([]),
    createReviewCommentReply: vi.fn(),
    listComments: vi.fn().mockResolvedValue([]),
    postComment: vi.fn(),
    postReview: vi.fn(),
    postOrUpdateComment: vi.fn(),
    createComment: vi.fn(),
    replyToReviewComment: vi.fn(),
  };
}

describe('ReviewEngine node floor', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('warns and continues by default when below the floor', () => {
    mockCheckNodeFloor.mockReturnValue({
      ok: false,
      current: '22.0.0',
      floor: '24.18.1',
      unparseable: false,
    });
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    expect(
      () => new ReviewEngine({ ...DEFAULT_CONFIG, timeoutMinutes: 10 }, makeAdapter() as never),
    ).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('22.0.0');
    warnSpy.mockRestore();
  });

  it('throws when enforcement is enabled and below the floor', () => {
    mockCheckNodeFloor.mockReturnValue({
      ok: false,
      current: '22.0.0',
      floor: '24.18.1',
      unparseable: false,
    });
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    expect(
      () =>
        new ReviewEngine(
          {
            ...DEFAULT_CONFIG,
            timeoutMinutes: 10,
            toolchain: { enforceNodeFloor: true },
          },
          makeAdapter() as never,
        ),
    ).toThrow(/enforced minimum/);
    (Logger.prototype.warn as unknown as { mockRestore: () => void }).mockRestore();
  });

  it('does not warn when at or above the floor', () => {
    mockCheckNodeFloor.mockReturnValue({
      ok: true,
      current: '24.18.1',
      floor: '24.18.1',
      unparseable: false,
    });
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    expect(
      () =>
        new ReviewEngine(
          {
            ...DEFAULT_CONFIG,
            timeoutMinutes: 10,
            toolchain: { enforceNodeFloor: true },
          },
          makeAdapter() as never,
        ),
    ).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('fails open on unparseable versions even with enforcement enabled', () => {
    mockCheckNodeFloor.mockReturnValue({
      ok: true,
      current: 'latest',
      floor: '24.18.1',
      unparseable: true,
    });
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    expect(
      () =>
        new ReviewEngine(
          {
            ...DEFAULT_CONFIG,
            timeoutMinutes: 10,
            toolchain: { enforceNodeFloor: true },
          },
          makeAdapter() as never,
        ),
    ).not.toThrow();
    warnSpy.mockRestore();
  });

  it('fails open when the floor check itself throws', () => {
    mockCheckNodeFloor.mockImplementation(() => {
      throw new Error('boom');
    });
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    expect(
      () =>
        new ReviewEngine(
          {
            ...DEFAULT_CONFIG,
            timeoutMinutes: 10,
            toolchain: { enforceNodeFloor: true },
          },
          makeAdapter() as never,
        ),
    ).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not re-throw unrelated errors containing the enforcement phrase', () => {
    mockCheckNodeFloor.mockImplementation(() => {
      throw new Error('unrelated enforced minimum text');
    });
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    expect(
      () =>
        new ReviewEngine(
          {
            ...DEFAULT_CONFIG,
            timeoutMinutes: 10,
            toolchain: { enforceNodeFloor: true },
          },
          makeAdapter() as never,
        ),
    ).not.toThrow();
    warnSpy.mockRestore();
  });

  it('stays fail-open when logging itself throws (warn-only mode)', () => {
    mockCheckNodeFloor.mockReturnValue({
      ok: false,
      current: '22.0.0',
      floor: '24.18.1',
      unparseable: false,
    });
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      throw new Error('logger down');
    });
    expect(
      () => new ReviewEngine({ ...DEFAULT_CONFIG, timeoutMinutes: 10 }, makeAdapter() as never),
    ).not.toThrow();
    (Logger.prototype.warn as unknown as { mockRestore: () => void }).mockRestore();
  });
});
