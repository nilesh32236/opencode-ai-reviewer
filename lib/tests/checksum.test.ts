import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  computeSha256,
  findChecksumAsset,
  getKnownChecksum,
  parseChecksumFile,
  verifyChecksum,
} from '../src/utils/checksum.js';

describe('computeSha256()', () => {
  it('computes SHA256 of a file', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksum-test-'));
    const filePath = path.join(tmpDir, 'test.bin');
    const content = 'hello world\n';
    fs.writeFileSync(filePath, content, 'utf-8');

    const hash = await computeSha256(filePath);
    const expected = crypto.createHash('sha256').update(content).digest('hex');
    expect(hash).toBe(expected);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('handles empty file', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksum-test-'));
    const filePath = path.join(tmpDir, 'empty.bin');
    fs.writeFileSync(filePath, '');

    const hash = await computeSha256(filePath);
    const expected = crypto.createHash('sha256').update('').digest('hex');
    expect(hash).toBe(expected);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('rejects on non-existent file', async () => {
    await expect(computeSha256('/tmp/nonexistent-file-xyz')).rejects.toThrow();
  });
});

describe('findChecksumAsset()', () => {
  const assets = [
    { name: 'opencode-linux-x64.tar.gz', browser_download_url: 'https://example.com/archive' },
    {
      name: 'opencode-linux-x64.tar.gz.sha256',
      browser_download_url: 'https://example.com/archive.sha256',
    },
    { name: 'checksums.txt', browser_download_url: 'https://example.com/checksums.txt' },
    { name: 'SHA256SUMS', browser_download_url: 'https://example.com/SHA256SUMS' },
  ];

  it('finds matching .sha256 file', () => {
    const result = findChecksumAsset(assets, 'opencode-linux-x64.tar.gz');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('opencode-linux-x64.tar.gz.sha256');
    expect(result!.browser_download_url).toBe('https://example.com/archive.sha256');
  });

  it('finds checksums.txt as fallback', () => {
    const withoutSha = assets.slice(0, 1).concat(assets.slice(2));
    const result = findChecksumAsset(withoutSha, 'opencode-linux-x64.tar.gz');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('checksums.txt');
  });

  it('finds SHA256SUMS as fallback', () => {
    const subset = [
      { name: 'opencode-linux-x64.tar.gz', browser_download_url: 'https://example.com/archive' },
      { name: 'SHA256SUMS', browser_download_url: 'https://example.com/SHA256SUMS' },
    ];
    const result = findChecksumAsset(subset, 'opencode-linux-x64.tar.gz');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('SHA256SUMS');
  });

  it('returns null when no checksum asset exists', () => {
    const noChecksum = [
      { name: 'opencode-linux-x64.tar.gz', browser_download_url: 'https://example.com/archive' },
    ];
    const result = findChecksumAsset(noChecksum, 'opencode-linux-x64.tar.gz');
    expect(result).toBeNull();
  });

  it('returns null for empty asset list', () => {
    expect(findChecksumAsset([], 'opencode-linux-x64.tar.gz')).toBeNull();
  });
});

describe('parseChecksumFile()', () => {
  it('parses standard sha256sum format (two spaces)', () => {
    const content =
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  opencode-linux-x64.tar.gz\n';
    const result = parseChecksumFile(content, 'opencode-linux-x64.tar.gz');
    expect(result).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('parses binary mode format (asterisk)', () => {
    const content =
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592 *opencode-linux-x64.tar.gz\n';
    const result = parseChecksumFile(content, 'opencode-linux-x64.tar.gz');
    expect(result).toBe('d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592');
  });

  it('parses format with leading ./ prefix', () => {
    const content =
      'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2  ./opencode-linux-x64.tar.gz\n';
    const result = parseChecksumFile(content, 'opencode-linux-x64.tar.gz');
    expect(result).toBe('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2');
  });

  it('skips comments and empty lines', () => {
    const content =
      '# This is a comment\n\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  opencode-linux-x64.tar.gz\n';
    const result = parseChecksumFile(content, 'opencode-linux-x64.tar.gz');
    expect(result).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('returns null when asset not in file', () => {
    const content =
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  some-other-file.tar.gz\n';
    const result = parseChecksumFile(content, 'opencode-linux-x64.tar.gz');
    expect(result).toBeNull();
  });

  it('returns null for empty content', () => {
    expect(parseChecksumFile('', 'opencode-linux-x64.tar.gz')).toBeNull();
  });

  it('handles multiple entries and picks the matching one', () => {
    const content = [
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  opencode-linux-x64.tar.gz',
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592  opencode-darwin-arm64.tar.gz',
    ].join('\n');
    const result = parseChecksumFile(content, 'opencode-darwin-arm64.tar.gz');
    expect(result).toBe('d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592');
  });
});

describe('verifyChecksum()', () => {
  it('passes when checksum matches', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksum-test-'));
    const filePath = path.join(tmpDir, 'test.bin');
    const content = 'verify me\n';
    fs.writeFileSync(filePath, content, 'utf-8');

    const expectedHash = crypto.createHash('sha256').update(content).digest('hex');
    const result = await verifyChecksum(filePath, expectedHash);
    expect(result).toBe(true);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('throws when checksum does not match', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksum-test-'));
    const filePath = path.join(tmpDir, 'test.bin');
    fs.writeFileSync(filePath, 'content a', 'utf-8');

    const wrongHash = crypto.createHash('sha256').update('content b').digest('hex');
    await expect(verifyChecksum(filePath, wrongHash)).rejects.toThrow('Checksum mismatch');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('is case-insensitive for expected checksum', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksum-test-'));
    const filePath = path.join(tmpDir, 'test.bin');
    const content = 'case test\n';
    fs.writeFileSync(filePath, content, 'utf-8');

    const expectedHash = crypto.createHash('sha256').update(content).digest('hex');
    const result = await verifyChecksum(filePath, expectedHash.toUpperCase());
    expect(result).toBe(true);

    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('getKnownChecksum()', () => {
  it('returns null for unknown version', () => {
    expect(getKnownChecksum('v9.9.9', 'linux-x64')).toBeNull();
  });

  it('returns null for unknown arch', () => {
    expect(getKnownChecksum('v1.0.0', 'linux-riscv64')).toBeNull();
  });

  it('returns null for empty version', () => {
    expect(getKnownChecksum('', 'linux-x64')).toBeNull();
  });
});
