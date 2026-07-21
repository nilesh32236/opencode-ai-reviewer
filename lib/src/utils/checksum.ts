import * as crypto from 'crypto';
import * as fs from 'fs';
import * as core from '@actions/core';

export async function computeSha256(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

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

export function parseChecksumFile(content: string, targetAssetName: string): string | null {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([a-fA-F0-9]{64})\s+[ *]?(.+)$/);
    if (match) {
      const [, hash, filename] = match;
      const cleanFilename = filename.replace(/^\.\//, '');
      if (cleanFilename === targetAssetName) {
        return hash.toLowerCase();
      }
    }
  }
  return null;
}

const KNOWN_CHECKSUMS: Record<string, string> = {
  // Format: `${version}-${arch}` → sha256 hex string
  // Entries populated as releases are manually verified
};

export function getKnownChecksum(version: string, arch: string): string | null {
  const key = `${version}-${arch}`;
  return KNOWN_CHECKSUMS[key] ?? null;
}

export async function verifyChecksum(filePath: string, expectedChecksum: string): Promise<boolean> {
  const actual = await computeSha256(filePath);
  if (actual !== expectedChecksum.toLowerCase()) {
    throw new Error(
      `Checksum mismatch for ${filePath}: expected ${expectedChecksum}, got ${actual}`,
    );
  }
  return true;
}
