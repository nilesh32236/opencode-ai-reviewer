#!/usr/bin/env node
/**
 * check-action-pins — warn-only guard pinning first-party Actions to node24 lines.
 *
 * Scans `.github/workflows/*.yml|*.yaml` for `actions/checkout@<ref>` and
 * `actions/setup-node@<ref>` pins plus `action.yml` (`runs.using: node24`)
 * and warns on drift off the v7 line. Additive, fail-open, CI-only.
 *
 * - Accepts `v7` / `v7.x` tags and known v7 SHA pins (with `# v7` comment).
 * - Warns (`::warning::`) on `v6` or lower, `main`/`master`, unknown SHAs.
 * - Missing/unreadable manifests: warning + exit 0 (fail open).
 * - Default mode: always exit 0. `CHECK_ACTION_PINS=strict` exits 1 on drift.
 *
 * Usage: node scripts/check-action-pins.mjs [--help]
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// Env overrides exist for hermetic fixture tests; defaults scan the repo.
const WORKFLOWS_DIR =
  process.env.CHECK_ACTION_PINS_WORKFLOWS_DIR || join(repoRoot, '.github', 'workflows');
const ACTION_YML = process.env.CHECK_ACTION_PINS_ACTION_YML || join(repoRoot, 'action.yml');

/** Known v7-line SHA pins (node24 line). */
const KNOWN_V7_SHAS = new Set([
  '3d3c42e5aac5ba805825da76410c181273ba90b1', // actions/checkout v7
  '820762786026740c76f36085b0efc47a31fe5020', // actions/setup-node v7
]);

function printHelp() {
  process.stdout.write(
    `check-action-pins — guard first-party Actions on the node24 (v7) line\n\n` +
      `Usage: node scripts/check-action-pins.mjs [--help]\n\n` +
      `Scans .github/workflows/*.{yml,yaml} for actions/checkout@ and\n` +
      `actions/setup-node@ pins and action.yml for runs.using: node24.\n\n` +
      `Allowed: v7, v7.x tags and known v7 SHAs (with "# v7" comment).\n` +
      `Warns on: v6 or lower, main/master, unknown SHAs.\n\n` +
      `Env:\n` +
      `  CHECK_ACTION_PINS=strict  exit 1 on drift (default: warn-only, exit 0)\n`,
  );
}

function isV7Tag(ref) {
  return /^v7(\.\d+)*$/.test(ref);
}

function isSha(ref) {
  return /^[0-9a-f]{40}$/i.test(ref);
}

function scanWorkflows() {
  const findings = [];
  let files = [];
  try {
    if (!existsSync(WORKFLOWS_DIR)) {
      process.stdout.write(
        `::warning::check-action-pins: workflows dir missing (${WORKFLOWS_DIR}) — skipping\n`,
      );
      return findings;
    }
    files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  } catch (err) {
    process.stdout.write(`::warning::check-action-pins: cannot list workflows — ${String(err)}\n`);
    return findings;
  }
  const pinRe = /actions\/(checkout|setup-node)@([^\s'"`,)]+)/g;
  for (const file of files) {
    const full = join(WORKFLOWS_DIR, file);
    let content;
    try {
      content = readFileSync(full, 'utf8');
    } catch (err) {
      process.stdout.write(`::warning::check-action-pins: unreadable ${file} — ${String(err)}\n`);
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      pinRe.lastIndex = 0;
      let m;
      while ((m = pinRe.exec(line)) !== null) {
        const action = m[1];
        const ref = m[2].replace(/[),;]+$/, '');
        const hasV7Comment = /#\s*v7(\.\d+)*/.test(line);
        if (isV7Tag(ref)) {
          process.stdout.write(`pinned ok: actions/${action}@${ref} (${file}:${i + 1})\n`);
        } else if (isSha(ref) && (hasV7Comment || KNOWN_V7_SHAS.has(ref.toLowerCase()))) {
          process.stdout.write(`pinned ok: actions/${action}@${ref} (${file}:${i + 1}, v7 line)\n`);
        } else {
          findings.push({ file, line: i + 1, action, ref });
          process.stdout.write(
            `::warning::check-action-pins: drift — actions/${action}@${ref} in ${file}:${i + 1} (expected v7 line)\n`,
          );
        }
      }
    }
  }
  if (files.length === 0) {
    process.stdout.write('::warning::check-action-pins: no workflow files found — skipping\n');
  }
  return findings;
}

function checkActionRuntime() {
  try {
    if (!existsSync(ACTION_YML)) {
      process.stdout.write(
        '::warning::check-action-pins: action.yml missing — skipping runtime check\n',
      );
      return false;
    }
    const content = readFileSync(ACTION_YML, 'utf8');
    const m = /using:\s*['"]?(node\d+)['"]?/.exec(content);
    if (!m) {
      process.stdout.write(
        '::warning::check-action-pins: cannot resolve runs.using in action.yml\n',
      );
      return false;
    }
    if (m[1] !== 'node24') {
      process.stdout.write(
        `::warning::check-action-pins: drift — action.yml runs.using is '${m[1]}' (expected 'node24')\n`,
      );
      return true;
    }
    process.stdout.write('runtime ok: action.yml runs.using is node24\n');
    return false;
  } catch (err) {
    process.stdout.write(`::warning::check-action-pins: unreadable action.yml — ${String(err)}\n`);
    return false;
  }
}

function main() {
  try {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
      printHelp();
      process.exit(0);
    }
    const drift = scanWorkflows();
    const runtimeDrift = checkActionRuntime();
    const total = drift.length + (runtimeDrift ? 1 : 0);
    const strict = (process.env.CHECK_ACTION_PINS ?? '').toLowerCase() === 'strict';
    if (total > 0) {
      process.stdout.write(
        `check-action-pins: done (drift=${total})${strict ? ' — strict mode' : ''}\n`,
      );
      if (strict) {
        process.stderr.write(
          `::error::check-action-pins: ${total} pin(s) off the v7/node24 line\n`,
        );
        process.exit(1);
      }
      process.exit(0);
    }
    process.stdout.write('check-action-pins: done (drift=0) — all pins on the v7/node24 line\n');
    process.exit(0);
  } catch (err) {
    // Fail open: never break CI on guard-internal errors.
    process.stdout.write(`::warning::check-action-pins: guard error — ${String(err)}\n`);
    process.exit(0);
  }
}

main();
