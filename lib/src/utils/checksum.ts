import * as crypto from 'crypto';
import * as fs from 'fs';

/**
 * Compute the SHA-256 hex digest of a file by streaming its contents.
 *
 * @param filePath - Absolute or relative path to the file on disk.
 * @returns The SHA-256 hash as a lowercase hex string.
 */
export async function computeSha256(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Find a checksum asset from a list of release assets that matches the given asset name.
 * Checks several common naming conventions (.sha256 suffix, checksums.txt, SHA256SUMS).
 *
 * @param assets - List of release assets with name and download URL.
 * @param assetName - Name of the asset to find checksums for (e.g., "binary.tar.gz").
 * @returns The matching checksum asset name and URL, or null if not found.
 */
export function findChecksumAsset(
  assets: Array<{ name: string; browser_download_url: string }>,
  assetName: string,
): { name: string; browser_download_url: string } | null {
  const baseName = assetName.replace(/\.(tar\.gz|zip)$/, '');
  const checksumCandidates = [
    `${assetName}.sha256`,
    `${baseName}.sha256`,
    'checksums.txt',
    'checksums.sha256',
    'SHA256SUMS',
    'SHA256SUMS.txt',
  ];

  for (const candidate of checksumCandidates) {
    const asset = assets.find((a) => a.name === candidate);
    if (asset) return { name: asset.name, browser_download_url: asset.browser_download_url };
  }

  for (const asset of assets) {
    if (asset.name.endsWith('.sha256') && asset.name.includes(baseName)) {
      return { name: asset.name, browser_download_url: asset.browser_download_url };
    }
  }

  return null;
}

/**
 * Parse a checksum file (SHA256SUMS format) to find the hash for a specific asset.
 * Supports both space-delimited and asterisk-prefixed formats.
 *
 * @param content - Raw text content of the checksum file.
 * @param targetAssetName - Name of the asset to find the checksum for.
 * @returns The SHA-256 hex string in lowercase, or null if not found.
 */
export function parseChecksumFile(content: string, targetAssetName: string): string | null {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.length < 65) continue;

    const hash = trimmed.slice(0, 64);
    if (!/^[a-fA-F0-9]{64}$/.test(hash)) continue;

    const rest = trimmed.slice(64).trimStart();
    const filename = rest.startsWith('*') ? rest.slice(1).trimStart() : rest;
    const cleanFilename = filename.replace(/^\.\//, '');

    if (cleanFilename === targetAssetName) {
      return hash.toLowerCase();
    }
  }
  return null;
}

const KNOWN_CHECKSUMS: Record<string, string> = {
  // Format: `${version}-${arch}` → sha256 hex string
  // Entries populated as releases are manually verified (only used when the
  // opencode_version input is pinned; 'latest' falls back to the release
  // checksum asset or a warning).
  //
  // Pinned 1.1.1 (== MINIMUM_OPENCODE_VERSION, see ./version.ts) CLI archives
  // from anomalyco/opencode release v1.1.1 (published 2026-01-04, verified
  // 2026-09-15 via the GitHub Releases API `digest` field, which is the
  // sha256 of the uploaded asset blob):
  // https://github.com/anomalyco/opencode/releases/tag/v1.1.1
  // Keys use the `detectArch()` matrix (opencode.ts) without extension, e.g.
  // `1.1.1-linux-x64` covers asset `opencode-linux-x64.tar.gz`.
  // No checksums.txt / .sha256 asset is published for this release, so these
  // pinned entries are currently the only offline verification source.
  // windows-arm64 has no published CLI archive for v1.1.1 (no entry below —
  // lookup stays fail-open null; see docs/opencode-checksums.md).
  // NOTE: v1.1.1 publishes darwin CLI archives as .zip only
  // (opencode-darwin-x64.zip, opencode-darwin-arm64.zip); there is no
  // opencode-darwin-*.tar.gz, so setupOpenCode() (which requests .tar.gz
  // on darwin) cannot download them — no darwin pins below (lookup stays
  // fail-open null); see docs/opencode-checksums.md.
  '1.1.1-linux-x64': 'c382005c97e4470596326675b5d6ba5bb9565c618666e9ee44026c163361c7bd',
  '1.1.1-linux-arm64': 'ba0a33ba77fbde8649b55208f6255cedd9797416d638ba4418fa83c879fc5d08',
  '1.1.1-windows-x64': 'adb80c1c5b902be3aafe27e5c4d4f109b6245593be3fd72e320efc36d3298579',
  //
  // Pinned 1.18.31 (== TESTED_OPENCODE_VERSION, see ./version.ts) CLI archives
  // from anomalyco/opencode release v1.18.31 (published 2026-09-14, verified
  // 2026-09-21 via the GitHub Releases API `digest` field, which is the
  // sha256 of the uploaded asset blob; cross-checked identical against the
  // upstream sst/opencode release v1.18.31, same date/assets):
  // https://github.com/anomalyco/opencode/releases/tag/v1.18.31
  // (upstream: https://github.com/sst/opencode/releases/tag/v1.18.31)
  // Keys use the `detectArch()` matrix (opencode.ts) without extension, e.g.
  // `1.18.31-linux-x64` covers asset `opencode-linux-x64.tar.gz`
  // (`opencode-<arch>.tar.gz` on Linux/macOS, `opencode-<arch>.zip` on
  // Windows — see setupOpenCode() in opencode.ts).
  // NOTE: v1.18.31 publishes darwin CLI archives as .zip only
  // (opencode-darwin-x64.zip, opencode-darwin-arm64.zip); there is no
  // opencode-darwin-*.tar.gz, so setupOpenCode() (which requests .tar.gz
  // on darwin) cannot download them — no darwin pins below (lookup stays
  // fail-open null); see docs/opencode-checksums.md.
  // Unlike v1.1.1, v1.18.31 DOES publish opencode-windows-arm64.zip, so a
  // windows-arm64 pin is included below.
  '1.18.31-linux-x64': 'e9312be75ed803b7415fc2aeabda1f4fe938912a39673762dc0c38c0e11ebde4',
  '1.18.31-linux-arm64': 'd4e332f46b227448582c0d9fc75f6f826dfe95c9f751bc2011fc4d937a042be6',
  '1.18.31-windows-x64': '0ecd7ffc7f26390ce7799e7bcd409e4f11c410144308a6a5b0fcdce63d871006',
  '1.18.31-windows-arm64': '1b20c559ac53e342046a0080bacb89cb3d40997943ecf18a2bc4d1b0398e33b2',
};

/**
 * Look up a known checksum for a specific version and architecture.
 *
 * The version is normalized by trimming surrounding whitespace and stripping
 * a single leading `v`/`V` (release `tag_name` values such as `v1.1.1` — the
 * form passed by `verifyDownloadedArchive()` in `opencode.ts` — resolve to
 * the same stored key as the bare semver `1.1.1`). Lookup stays fail-open:
 * unknown version/arch pairs return null instead of throwing.
 * @param version - Version string (e.g., "1.2.3", "v1.2.3", or " V1.2.3 ").
 * @param arch - Architecture identifier (e.g., "linux-x64").
 * @returns The known SHA-256 hex string, or null if no match.
 * @since NEXT - Added leading-v/V normalization (with whitespace trim) so tag_name lookups hit pinned keys; function itself pre-existed.
 */
export function getKnownChecksum(version: string, arch: string): string | null {
  const normalizedVersion = version.trim().replace(/^v/i, '');
  const key = `${normalizedVersion}-${arch}`;
  return KNOWN_CHECKSUMS[key] ?? null;
}

/**
 * HTTP-style status attached to deterministic integrity failures (missing
 * checksum under strict enforcement, checksum mismatch) so {@link withRetry}
 * fails fast instead of re-downloading with backoff. 422 is never in the
 * default `retryableStatuses`, matching the repo convention for deterministic
 * application errors (see github/gitlab adapter tests).
 */
export const INTEGRITY_ERROR_STATUS = 422;

/**
 * Tag a deterministic integrity error as non-retryable for `withRetry`.
 * Transient network/download errors stay status-less (retryable); only the
 * integrity outcome itself fails fast.
 * @param err - The integrity error to tag.
 * @returns The same error instance, with a non-retryable `status` attached.
 */
export function markIntegrityError<T extends Error>(err: T): T {
  (err as Error & { status?: number }).status = INTEGRITY_ERROR_STATUS;
  return err;
}

/**
 * Build the fail-closed error thrown when checksum enforcement is on but no
 * checksum is available for the downloaded archive.
 *
 * Enforcement is enabled via the `require_opencode_checksum` action input
 * (surfaced to `lib` as the `INPUT_REQUIRE_OPENCODE_CHECKSUM` env var, see
 * `resolveRequireChecksum` in `opencode.ts`).
 * @param version - Pinned version string (e.g. "1.2.3").
 * @param assetName - Release asset file name (e.g. "opencode-linux-x64.tar.gz").
 * @param arch - Architecture identifier (e.g. "linux-x64").
 * @returns A human-friendly Error with pin-plus-sha256 remediation steps.
 *   The error carries {@link INTEGRITY_ERROR_STATUS} so download retries fail
 *   fast instead of re-downloading a deterministically unverifiable archive.
 * @since NEXT
 */
export function buildMissingChecksumError(version: string, assetName: string, arch: string): Error {
  const unsupportedArchNote = ['darwin-x64', 'darwin-arm64', 'windows-arm64'].includes(arch)
    ? `\nNote: strict enforcement is currently unsatisfiable on ${arch} for 1.1.1 — ` +
      `no installer-compatible archive is pinned for this arch (darwin publishes .zip only, ` +
      `windows-arm64 publishes no CLI archive), so no pin can satisfy this error on ${arch}. ` +
      `Use a linux-x64, linux-arm64, or windows-x64 runner, or a release that publishes a checksum asset covering ${arch}.`
    : '';
  const err = new Error(
    `OpenCode integrity verification failed: no checksum available for ${assetName} ` +
      `(version ${version}, arch ${arch}) and require_opencode_checksum is enabled.\n` +
      `Pin opencode_version to a pinned version in docs/opencode-checksums.md ` +
      `(https://github.com/anomalyco/opencode-ai-reviewer/blob/main/docs/opencode-checksums.md) ` +
      `covering your arch (linux-x64, linux-arm64, windows-x64 for 1.1.1; no darwin/windows-arm64 pin exists) ` +
      `or to a release that publishes a checksum asset ` +
      `(e.g. "${assetName}.sha256" or "checksums.txt") containing an entry for ${assetName}.${unsupportedArchNote}\n` +
      `(Maintainers can additionally record a manually verified sha256 in KNOWN_CHECKSUMS ` +
      `in lib/src/utils/checksum.ts for pinned versions; see docs/opencode-checksums.md.)\n` +
      `Only as a last resort, and at your own risk (this disables integrity protection), re-run with require_opencode_checksum explicitly disabled ` +
      `(warn-and-continue only when explicitly set to false) while you obtain the expected sha256 out-of-band.`,
  );
  return markIntegrityError(err);
}

/**
 * Verify a file's SHA-256 checksum against an expected value.
 * Throws on mismatch rather than returning false.
 *
 * @param filePath - Path to the file to verify.
 * @param expectedChecksum - Expected SHA-256 hex string.
 * @returns True if the checksum matches.
 * @throws Error if the checksum does not match.
 */
export async function verifyChecksum(filePath: string, expectedChecksum: string): Promise<boolean> {
  const actual = await computeSha256(filePath);
  if (actual !== expectedChecksum.toLowerCase()) {
    throw new Error(
      `Checksum mismatch for ${filePath}: expected ${expectedChecksum}, got ${actual}`,
    );
  }
  return true;
}
