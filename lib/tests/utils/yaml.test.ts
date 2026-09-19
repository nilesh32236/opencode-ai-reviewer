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

/** Snapshot any pre-existing global `polluted` marker before parsing. */
function savePollutionMarker(): { hadMarker: boolean; prior: unknown } {
  return { hadMarker: Reflect.has(Object.prototype, 'polluted'), prior: readPollutionMarker() };
}

/**
 * Restore the pre-test prototype state: remove test-introduced pollution,
 * reinstate a genuinely pre-existing marker untouched. A blind delete would
 * destroy pre-existing state; a conditional delete would leave real
 * pollution behind — the pre-parse snapshot distinguishes the two.
 */
function restorePollutionMarker(saved: { hadMarker: boolean; prior: unknown }): void {
  Reflect.deleteProperty(Object.prototype, 'polluted');
  if (saved.hadMarker) {
    Object.defineProperty(Object.prototype, 'polluted', {
      value: saved.prior,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
}

// @since NEXT: regression coverage for js-yaml prototype-pollution hardening.
describe('parseConfigYaml', () => {
  it('documents the js-yaml safe floor version', () => {
    expect(JS_YAML_SAFE_FLOOR).toBe('4.3.0');
  });

  it('strips __proto__ keys without polluting Object.prototype', () => {
    const savedMarker = savePollutionMarker();
    const parsed = parseConfigYaml(
      '__proto__:\n  polluted: "yes"\nreview:\n  systemPrompt: "ok"\n',
    );
    expect(parsed).not.toBeNull();
    expect(Object.hasOwn(parsed!, '__proto__')).toBe(false);
    expect((parsed?.review as { systemPrompt?: unknown } | undefined)?.systemPrompt).toBe('ok');
    expect(readPollutionMarker()).toBeUndefined();
    restorePollutionMarker(savedMarker);
  });

  it('strips nested constructor/prototype chains', () => {
    const savedMarker = savePollutionMarker();
    const parsed = parseConfigYaml(
      'review:\n  systemPrompt: "ok"\nconstructor:\n  prototype:\n    polluted: "yes"\n',
    );
    expect(parsed).not.toBeNull();
    expect(Object.hasOwn(parsed!, 'constructor')).toBe(false);
    expect(readPollutionMarker()).toBeUndefined();
    restorePollutionMarker(savedMarker);
  });

  it('rejects !!js/* tags instead of materializing them', () => {
    const savedMarker = savePollutionMarker();
    // !!js/function would code-exec via `new Function` under the default
    // schema; JSON_SCHEMA fails the parse and parseConfigYaml falls open.
    expect(parseConfigYaml('run: !!js/function "function(){ return 1 }"')).toBeNull();
    expect(parseConfigYaml('re: !!js/regexp "/x/g"')).toBeNull();
    expect(readPollutionMarker()).toBeUndefined();
    restorePollutionMarker(savedMarker);
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
    const savedMarker = savePollutionMarker();
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
    restorePollutionMarker(savedMarker);
  });
});
