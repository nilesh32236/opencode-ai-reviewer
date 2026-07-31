import { PassThrough } from 'stream';
import { describe, expect, it, vi } from 'vitest';

const { mockCreateReadStream, mockCreateInterface } = vi.hoisted(() => ({
  mockCreateReadStream: vi.fn(),
  mockCreateInterface: vi.fn(),
}));

vi.mock('fs', () => ({
  createReadStream: mockCreateReadStream,
}));

vi.mock('node:readline', () => ({
  createInterface: mockCreateInterface,
}));

import { parseJsonlFile } from '../src/jsonl-parser.js';

describe('parseJsonlFile resource cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('closes the readline interface and stream when the read loop throws', async () => {
    const stream = new PassThrough();
    const destroySpy = vi.spyOn(stream, 'destroy');
    mockCreateReadStream.mockReturnValue(stream);

    const closeSpy = vi.fn();
    mockCreateInterface.mockReturnValue({
      [Symbol.asyncIterator]() {
        let index = 0;
        const lines = [JSON.stringify({ type: 'summary', text: 'ok' })];
        return {
          next: async () => {
            if (index < lines.length) {
              index++;
              return { value: lines[0], done: false };
            }
            throw new Error('simulated mid-stream failure');
          },
        };
      },
      close: closeSpy,
    });

    await expect(parseJsonlFile('/tmp/parse-error.jsonl')).rejects.toThrow(
      'simulated mid-stream failure',
    );

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it('closes the readline interface and stream on a stream error (ENOENT)', async () => {
    const stream = new PassThrough();
    const destroySpy = vi.spyOn(stream, 'destroy');
    mockCreateReadStream.mockReturnValue(stream);

    const closeSpy = vi.fn();
    mockCreateInterface.mockReturnValue({
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<string>>(() => {}),
        };
      },
      close: closeSpy,
    });

    const result = parseJsonlFile('/tmp/missing.jsonl');
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    stream.emit('error', err);

    await expect(result).resolves.toMatchObject({ summary: '' });
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });
});
