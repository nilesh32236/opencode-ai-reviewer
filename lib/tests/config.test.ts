import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { DEFAULT_CONFIG } from '../src/types/index.js';
import { AgentConfigSchema } from '../src/types/schemas.js';

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

  it('parses learning config via zod schema', () => {
    const result = AgentConfigSchema.parse({
      learning: {
        enabled: true,
        metaReview: { interval: 10 },
        patternDiscovery: { minFrequency: 5 },
      },
    });
    expect(result.learning.metaReview.interval).toBe(10);
    expect(result.learning.patternDiscovery.minFrequency).toBe(5);
  });

  it('applies learning defaults', () => {
    const result = AgentConfigSchema.parse({});
    expect(result.learning.metaReview.interval).toBe(5);
    expect(result.learning.patternDiscovery.minFrequency).toBe(3);
    expect(result.learning.patternDiscovery.windowSize).toBe(100);
  });
});
