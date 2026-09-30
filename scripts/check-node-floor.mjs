#!/usr/bin/env node
// Refuse to build the committed action bundles on a Node version below the
// declared floor.
//
// WHY THIS EXISTS. The action's production runtime is the COMMITTED bundle
// (action.yml declares `main: 'action/lib/index.js'`), and CI's "Verify
// committed action bundles are fresh" step rebuilds and diffs it. `@vercel/ncc`
// assigns webpack module IDs in an order that is stable within a Node minor but
// NOT stable across minors, so a build on Node 24.20.0 produces a byte-different
// -- though functionally identical -- bundle than one on 24.21.0+.
//
// Measured on this repo: two consecutive builds on the same Node are identical
// (the build IS deterministic), but a rebuild on Node v24.20.0 against a bundle
// committed by CI on 24.21.0+ differs by module-ID renumbering alone. package.json
// declares engines.node >=24.21.0, but `engine-strict` is not set, so pnpm only
// warns and the build proceeds -- producing a diff that the freshness check
// reports as "committed action bundles are stale" for a bundle that is not
// actually stale.
//
// Failing here converts a confusing CI failure and a pile of duplicate health
// issues into one clear message at build time.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Parse a leading `major.minor.patch` out of a version string. */
function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Compare parsed version tuples. Returns -1, 0 or 1. */
function cmp(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const required = String(pkg.engines?.node ?? '').replace(/^[^0-9]*/, '');
const have = parse(process.versions.node);
const need = parse(required);

if (!need) {
  // No parseable floor declared -- nothing to enforce.
  process.exit(0);
}

if (!have || cmp(have, need) < 0) {
  process.stderr.write(
    `Refusing to build the committed action bundles.\n` +
      `  required Node: ${required}\n` +
      `  running Node:  ${process.versions.node}\n` +
      `\n` +
      `ncc assigns webpack module IDs in an order that is stable within a Node\n` +
      `minor but not across minors. Building below the floor produces a bundle that\n` +
      `differs from the committed one by module-ID renumbering alone, which the CI\n` +
      `check "Verify committed action bundles are fresh" reports as a STALE bundle.\n` +
      `That is a false failure: the committed bundle is fine, the build node is not.\n` +
      `\n` +
      `Install a conforming Node and rebuild. Do not commit a bundle produced\n` +
      `below the floor -- it will differ from every other build of the same source.\n`,
  );
  process.exit(0);
}
