import { describe, expect, it } from 'vitest';
import { iterateLines } from '../../src/utils/string-lines.js';

describe('iterateLines', () => {
  it('yields the same items as String.prototype.split("\\n")', () => {
    const cases = ['', '\n', 'a\n', '\nb', 'a\nb', 'a\n\nb', 'a\r\nb', 'abc', '\n\n\n'];

    for (const input of cases) {
      const generated = Array.from(iterateLines(input));
      const split = input.split('\n');
      expect(generated).toEqual(split);
    }
  });

  it('evaluates lazily and can be aborted', () => {
    const input = 'a\nb\nc\nd';
    const gen = iterateLines(input);

    expect(gen.next().value).toBe('a');
    expect(gen.next().value).toBe('b');

    // Explicitly do not pull the rest
    expect(gen.return?.().done).toBe(true);
  });
});
