import * as core from '@actions/core';
import yaml from 'js-yaml';

/**
 * Minimum safe js-yaml version guarding against known prototype-pollution
 * advisories. The `js-yaml` dependency range in `package.json` (`^4.3.0`)
 * must never be widened below this floor.
 *
 * @since NEXT
 */
export const JS_YAML_SAFE_FLOOR = '4.3.0';

/**
 * Object keys that must never be copied out of parsed YAML. `__proto__` is
 * the classic prototype-pollution vector (`obj["__proto__"]` resolves to
 * `Object.prototype`); `constructor` / `prototype` complete the alternate
 * `constructor.prototype` chain. None of these are valid config keys
 * (they would be reported as unknown keys anyway), so dropping them is
 * behavior-preserving for benign configs.
 */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Deep-clone a `yaml.load` result into fresh plain objects/arrays while
 * dropping prototype-pollution keys at every level.
 *
 * Objects are rebuilt from `Object.keys` (own enumerable keys) into a new
 * `{}` so a `__proto__` entry that js-yaml materialized via the prototype
 * setter is left behind rather than carried over.
 *
 * Mapping-only by design: non-plain objects (Date, Map, class instances)
 * are coerced to plain `{}` and symbol/non-enumerable keys are dropped.
 * That is safe here because the parser runs under `JSON_SCHEMA` (plain
 * scalars/collections only), and config values never need class instances.
 *
 * @param value - Raw value produced by `yaml.load`.
 * @returns Sanitized deep clone with unsafe keys removed.
 *
 * @since NEXT
 */
export function sanitizeYamlValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeYamlValue(item));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (UNSAFE_KEYS.has(key)) {
        core.warning(`Ignoring unsafe YAML key "${key}"`);
        continue;
      }
      result[key] = sanitizeYamlValue((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

/**
 * Parse YAML config content with prototype-pollution hardening.
 *
 * Parses under `JSON_SCHEMA` so `!!js/*` tags (`!!js/function` code exec
 * via `new Function`, `!!js/regexp`, `!!js/undefined`) never materialize —
 * key-stripping alone cannot neutralize those. Unknown tags fail the parse
 * and fall through to the fail-open `null` below.
 *
 * Fail-open: parser errors are caught, a warning is logged, and `null` is
 * returned so callers fall back to safe defaults. Non-object documents
 * (empty files, scalars, arrays) also yield `null`.
 *
 * @param content - Raw YAML file content.
 * @returns Sanitized plain object, or `null` when parsing fails or the
 * document is not a mapping.
 *
 * @since NEXT
 */
export function parseConfigYaml(content: string): Record<string, unknown> | null {
  let raw: unknown;
  try {
    raw = yaml.load(content, { schema: yaml.JSON_SCHEMA });
  } catch (error) {
    core.warning(`Failed to parse YAML config: ${String(error)}`);
    return null;
  }
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  return sanitizeYamlValue(raw) as Record<string, unknown>;
}
