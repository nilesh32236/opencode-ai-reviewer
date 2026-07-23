import * as crypto from 'crypto';
import * as fs from 'fs';
import * as core from '@actions/core';

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
  // Entries populated as releases are manually verified
};

/**
 * Look up a known checksum for a specific version and architecture.
 *
 * @param version - Version string (e.g., "1.2.3").
 * @param arch - Architecture identifier (e.g., "linux-amd64").
 * @returns The known SHA-256 hex string, or null if no match.
 */
export function getKnownChecksum(version: string, arch: string): string | null {
  const key = `${version}-${arch}`;
  return KNOWN_CHECKSUMS[key] ?? null;
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
