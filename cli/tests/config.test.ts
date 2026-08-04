import { DEFAULT_CONFIG } from '@opencode-pr-agent/lib';
import { describe, expect, it } from 'vitest';
import { buildAgentConfig } from '../src/config.js';

describe('buildAgentConfig', () => {
  it('defaults to the built-in review settings when no config file is present', () => {
    const config = buildAgentConfig(null);
    expect(config.review.suppressLowConfidence).toBe(DEFAULT_CONFIG.review.suppressLowConfidence);
    expect(config.review.inline).toBe(DEFAULT_CONFIG.review.inline);
  });

  it('passes review.suppressLowConfidence through to AgentConfig.review', () => {
    const config = buildAgentConfig({ review: { suppressLowConfidence: true } });
    expect(config.review.suppressLowConfidence).toBe(true);
  });

  it('keeps config-file values out of settings the CLI does not consume', () => {
    const config = buildAgentConfig({ review: { suppressLowConfidence: false } });
    expect(config.review.suppressLowConfidence).toBe(false);
  });
});
