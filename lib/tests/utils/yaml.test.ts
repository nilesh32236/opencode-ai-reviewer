import { describe, expect, it, vi } from 'vitest';

vi.mock('@actions/core', () => {
  const warning = vi.fn();
  const info = vi.fn();
  const debug = vi.fn();
  const setFailed = vi.fn();
  return { warning, info, debug, setFailed };
});

import { JS_YAML_SAFE_FLOOR, parseConfigYaml, sanitizeYamlValue } from '../../src/utils/yaml.js';

/** Read a global prototype-pollution marker without computed member access. */
function readPollutionMarker(): unknown {
  return Reflect.get(Object.prototype, 'polluted');
}

/** Defensively clear a global prototype-pollution marker if one was set. */
function clearPollutionMarker(): void {
  Reflect.deleteProperty(Object.prototype, 'polluted');
}

// @since NEXT: regression coverage for js-yaml prototype-pollution hardening.
describe('parseConfigYaml', () => {
  it('documents the js-yaml safe floor version', () => {
    expect(JS_YAML_SAFE_FLOOR).toBe('4.3.0');
  });

  it('strips __proto__ keys without polluting Object.prototype', () => {
    const parsed = parseConfigYaml(
      '__proto__:\n  polluted: "yes"\nreview:\n  systemPrompt: "ok"\n',
    );
    expect(parsed).not.toBeNull();
    expect(Object.hasOwn(parsed!, '__proto__')).toBe(false);
    expect((parsed?.review as { systemPrompt?: unknown } | undefined)?.systemPrompt).toBe('ok');
    expect(readPollutionMarker()).toBeUndefined();
    clearPollutionMarker();
  });

  it('strips nested constructor/prototype chains', () => {
    const parsed = parseConfigYaml(
      'review:\n  systemPrompt: "ok"\nconstructor:\n  prototype:\n    polluted: "yes"\n',
    );
    expect(parsed).not.toBeNull();
    expect(Object.hasOwn(parsed!, 'constructor')).toBe(false);
    expect(readPollutionMarker()).toBeUndefined();
    clearPollutionMarker();
  });

  it('fails open to null on parser errors', () => {
    expect(parseConfigYaml('invalid: [yaml: broken')).toBeNull();
  });

  it('returns null for empty, scalar, and array documents', () => {
    expect(parseConfigYaml('')).toBeNull();
    expect(parseConfigYaml('just a string')).toBeNull();
    expect(parseConfigYaml('- a\n- b\n')).toBeNull();
  });

  it('sanitizeYamlValue deep-clones arrays and drops unsafe keys', () => {
    // JSON.parse materializes __proto__ as a real own property (an object
    // literal would instead set the prototype), so this exercises the filter.
    const input: unknown = JSON.parse(
      '{"items": [{"__proto__": {"polluted": "yes"}, "name": "a"}]}',
    );
    const rawItem = (input as { items: Record<string, unknown>[] }).items[0];
    expect(Object.hasOwn(rawItem, '__proto__')).toBe(true);
    const result = sanitizeYamlValue(input) as { items: Array<{ name?: unknown }> };
    const item = result.items[0];
    expect(Object.hasOwn(item, '__proto__')).toBe(false);
    expect(item.name).toBe('a');
    expect(readPollutionMarker()).toBeUndefined();
    clearPollutionMarker();
  });
});
