import { describe, expect, it } from 'vitest';
import { parseAgentJsonlString, parseJsonlString } from '../src/jsonl-parser.js';

describe('JSONL Parser Boundary Tests', () => {
  describe('parseJsonlString boundaries', () => {
    it('handles empty string', () => {
      const result = parseJsonlString('');
      expect(result.rawLines).toEqual([]);
    });

    it('handles single character with trailing newline', () => {
      const result = parseJsonlString('a\n');
      expect(result.rawLines).toEqual(['a']);
    });

    it('handles consecutive newlines', () => {
      const result = parseJsonlString('a\n\nb');
      expect(result.rawLines).toEqual(['a', 'b']);
    });

    it('handles CRLF', () => {
      const result = parseJsonlString('a\r\nb\r\n');
      expect(result.rawLines).toEqual(['a', 'b']);
    });
  });

  describe('parseAgentJsonlString boundaries (uses preprocessAgentJsonl)', () => {
    it('handles empty string', () => {
      const result = parseAgentJsonlString('', 'security');
      expect(result.rawOutput).toBe('');
    });

    it('handles single character with trailing newline', () => {
      const result = parseAgentJsonlString('a\n', 'security');
      expect(result.rawOutput).toBe('a\n');
    });

    it('handles consecutive newlines', () => {
      const result = parseAgentJsonlString('a\n\nb', 'security');
      expect(result.rawOutput).toBe('a\n\nb');
    });

    it('handles CRLF', () => {
      const result = parseAgentJsonlString('a\r\nb\r\n', 'security');
      expect(result.rawOutput).toBe('a\r\nb\r\n');
    });
  });
});
