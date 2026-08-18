import { describe, it, expect } from 'vitest';
import { sanitizeError, sanitizeErrorMessage } from '../../src/utils/logger.js';

describe('Logger utilities', () => {
  describe('sanitizeError', () => {
    it('redacts tokens from error messages', () => {
      const error = new Error('Git clone failed for https://x-access-token:ghs_SECRET12345678901234567890123456789012@github.com/owner/repo.git');
      const sanitized = sanitizeError(error);
      expect(sanitized).not.toContain('ghs_SECRET12345678901234567890123456789012');
      expect(sanitized).toContain('https://x-access-token:[REDACTED]@github.com/owner/repo.git');
    });
  });

  describe('sanitizeErrorMessage', () => {
    it('redacts tokens from error messages and omits stack trace', () => {
      const error = new Error('Git clone failed for https://x-access-token:ghp_SECRET12345678901234567890123456789012@github.com/owner/repo.git');
      const sanitized = sanitizeErrorMessage(error);
      expect(sanitized).not.toContain('ghp_SECRET12345678901234567890123456789012');
      expect(sanitized).toContain('https://x-access-token:[REDACTED]@github.com/owner/repo.git');
      expect(sanitized).not.toContain('Error: Git clone failed'); // Assuming stack trace usually starts like this
    });

    it('handles string input directly', () => {
      const message = 'Git clone failed for https://x-access-token:ghp_SECRET12345678901234567890123456789012@github.com/owner/repo.git';
      const sanitized = sanitizeErrorMessage(message);
      expect(sanitized).not.toContain('ghp_SECRET12345678901234567890123456789012');
      expect(sanitized).toContain('https://x-access-token:[REDACTED]@github.com/owner/repo.git');
    });
  });
});
