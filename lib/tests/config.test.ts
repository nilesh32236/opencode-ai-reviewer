import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { DEFAULT_CONFIG } from '../src/types/index.js';

describe('config', () => {
  it('DEFAULT_CONFIG is defined', () => {
    expect(DEFAULT_CONFIG).toBeDefined();
    expect(DEFAULT_CONFIG.reviewModel).toBeTruthy();
  });

  it('loadConfig returns null when config file missing', () => {
    const config = loadConfig('/nonexistent');
    expect(config).toBeNull();
  });

  it('loadConfig returns null for empty working dir', () => {
    const config = loadConfig('');
    expect(config).toBeNull();
  });
});
