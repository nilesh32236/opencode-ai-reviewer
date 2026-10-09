# Pinned OpenCode CLI Checksums

Install manifest for the OpenCode CLI archives downloaded by
`setupOpenCode()` (`lib/src/opencode.ts`). Verification runs automatically
when a checksum is available: both the Action and the underlying `lib` API
enforce it by default and fail closed when an archive cannot be verified.
Set `require_opencode_checksum: 'false'` (Action) or pass
`{ requireChecksum: false }` / `INPUT_REQUIRE_OPENCODE_CHECKSUM=false`
(`lib`) to restore the fail-open warn-and-continue behavior.

Checksum-file verification is transport-integrity only: the checksum file is
fetched from the same release/trust domain as the archive with no signature
or attestation verification, so a compromised publisher token defeats both
together. Authenticity comes solely from the offline `KNOWN_CHECKSUMS` pins
below until attestation verification lands.

> **Verified:** 2026-09-15 against the `anomalyco/opencode` release `v1.1.1`
> (published 2026-01-04) via the GitHub Releases API `digest` field (sha256 of
> the uploaded asset blob).
> Release page: https://github.com/anomalyco/opencode/releases/tag/v1.1.1
> Pinned version equals `MINIMUM_OPENCODE_VERSION` (`lib/src/utils/version.ts`).
>
> **Verified:** 2026-09-21 against the `anomalyco/opencode` release `v1.18.31`
> (published 2026-09-14) via the GitHub Releases API `digest` field (sha256 of
> the uploaded asset blob), cross-checked identical against the upstream
> `sst/opencode` release `v1.18.31` (same date/assets).
> Release page: https://github.com/anomalyco/opencode/releases/tag/v1.18.31
> (upstream: https://github.com/sst/opencode/releases/tag/v1.18.31)
> This was the prior `TESTED_OPENCODE_VERSION` pin; its rows are kept below
> as historical pins.
>
> **Verified:** 2026-10-07 against the `anomalyco/opencode` release `v1.18.35`
> (published 2026-10-06) via the GitHub Releases API `digest` field (sha256 of
> the uploaded asset blob), each digest confirmed identical to the `sha256sum`
> of the downloaded asset.
> Release page: https://github.com/anomalyco/opencode/releases/tag/v1.18.35
> Pinned version equals `TESTED_OPENCODE_VERSION` (`lib/src/utils/version.ts`)
> and is the pin used by `.github/workflows/ai-review.yml` (all four
> `uses: ./` jobs pass `opencode_version: 'v1.18.35'` with
> `require_opencode_checksum: 'true'`) and
> `.github/workflows/scheduled-audit.yml` (`opencode_version: 'v1.18.35'`).
> Hygiene bump only: the v1.18.32–v1.18.35 release notes contain no free-tier
> dispatch fix.
>
> **Tested version:** `1.18.35` (`TESTED_OPENCODE_VERSION` in
> `lib/src/utils/version.ts`). The health check (`checkHealth()` in
> `lib/src/opencode.ts`) warns — without failing — when the installed CLI is
> `>= 1.1.1` but below `1.15.0` (`WARN_BELOW_OPENCODE_VERSION`), pointing at
> the tested version. CLI docs: https://opencode.ai/docs/cli (v1.18, accessed
> 2026-09-16). Releases: https://github.com/sst/opencode/releases (accessed
> 2026-09-16).

## Pinned sha256 (`opencode_version: 1.1.1` / `v1.1.1`)

Keys use the `detectArch()` matrix (`linux-x64`, `linux-arm64`, `darwin-x64`,
`darwin-arm64`, `windows-x64`, `windows-arm64`); the file column is the exact
asset name `setupOpenCode()` downloads (`opencode-<arch>.tar.gz` on
Linux/macOS, `opencode-<arch>.zip` on Windows). Only installer-compatible
assets are pinned below.

| opencode_version | arch | file | sha256 |
|---|---|---|---|
| 1.1.1 | linux-x64 | `opencode-linux-x64.tar.gz` | `c382005c97e4470596326675b5d6ba5bb9565c618666e9ee44026c163361c7bd` |
| 1.1.1 | linux-arm64 | `opencode-linux-arm64.tar.gz` | `ba0a33ba77fbde8649b55208f6255cedd9797416d638ba4418fa83c879fc5d08` |
| 1.1.1 | windows-x64 | `opencode-windows-x64.zip` | `adb80c1c5b902be3aafe27e5c4d4f109b6245593be3fd72e320efc36d3298579` |

## Pinned sha256 (`opencode_version: 1.18.31` / `v1.18.31`)

Same key/matrix conventions as above. Unlike `v1.1.1`, this release **does**
publish `opencode-windows-arm64.zip`, so a windows-arm64 pin is included.
Darwin remains `.zip`-only (no installer-compatible `.tar.gz`), so there are
intentionally no darwin pins — `getKnownChecksum()` returns `null`
(fail-open) for darwin arches.

| opencode_version | arch | file | sha256 |
|---|---|---|---|
| 1.18.31 | linux-x64 | `opencode-linux-x64.tar.gz` | `e9312be75ed803b7415fc2aeabda1f4fe938912a39673762dc0c38c0e11ebde4` |
| 1.18.31 | linux-arm64 | `opencode-linux-arm64.tar.gz` | `d4e332f46b227448582c0d9fc75f6f826dfe95c9f751bc2011fc4d937a042be6` |
| 1.18.31 | windows-x64 | `opencode-windows-x64.zip` | `0ecd7ffc7f26390ce7799e7bcd409e4f11c410144308a6a5b0fcdce63d871006` |
| 1.18.31 | windows-arm64 | `opencode-windows-arm64.zip` | `1b20c559ac53e342046a0080bacb89cb3d40997943ecf18a2bc4d1b0398e33b2` |

## Pinned sha256 (`opencode_version: 1.18.35` / `v1.18.35`)

Same key/matrix conventions as above. Like `v1.18.31`, this release **does**
publish `opencode-windows-arm64.zip`, so a windows-arm64 pin is included.
Darwin remains `.zip`-only (no installer-compatible `.tar.gz`), so there are
intentionally no darwin pins — `getKnownChecksum()` returns `null`
(fail-open) for darwin arches.

| opencode_version | arch | file | sha256 |
|---|---|---|---|
| 1.18.35 | linux-x64 | `opencode-linux-x64.tar.gz` | `c8f888b451f5494a18f858fffb0e0b68f4e4baa9c241761c5f206884f0fa640d` |
| 1.18.35 | linux-arm64 | `opencode-linux-arm64.tar.gz` | `f7f2ba59ee8aa94d388f9696575a32d20e71c2ee48def9f80fc693a60fec6c72` |
| 1.18.35 | windows-x64 | `opencode-windows-x64.zip` | `c90d248cca75e42fd15422a29b5f83a1b30c441af83565635d6b2682adc58dd1` |
| 1.18.35 | windows-arm64 | `opencode-windows-arm64.zip` | `3c144f54fea5d56afb00174fd3134709803a7bb6ce990963044831b671bd9882` |

Notes:

- `v1.1.1` publishes darwin CLI archives as `.zip` only
  (`opencode-darwin-x64.zip`, `opencode-darwin-arm64.zip`); there is no
  `opencode-darwin-*.tar.gz`, so `setupOpenCode()` (which requests `.tar.gz`
  on macOS) cannot download them — there are intentionally no darwin pins
  above and `getKnownChecksum()` returns `null` (fail-open) for darwin arches.
  The full `.zip` digests (`684c948c88a7043671c7689b92b6657f671e007c1dbea23e9072a6ec8078cc78`
  for x64, `880c1bdbbb6dedf41089c509e8a8a5516b7358b181e5dda8213c2b90985b4332`
  for arm64) are therefore useful for manual verification only, not for
  installer verification.

- `windows-arm64` has **no published CLI archive** for `v1.1.1`, so there is
  no pinned entry — `getKnownChecksum()` returns `null` (fail-open) for it.
- This release publishes **no `checksums.txt` / `.sha256` asset**
  (`findChecksumAsset()` finds nothing), so these pinned `KNOWN_CHECKSUMS`
  entries in `lib/src/utils/checksum.ts` are currently the only offline
  verification source for `1.1.1`.
- `getKnownChecksum()` accepts both `1.1.1` and `v1.1.1` (leading `v` is
  stripped — the download path passes through `release.tag_name`, e.g.
  `v1.1.1`).

## Manual verify

```bash
# Linux (example: linux-x64)
curl -sL -o opencode-linux-x64.tar.gz \
  https://github.com/anomalyco/opencode/releases/download/v1.1.1/opencode-linux-x64.tar.gz
echo "c382005c97e4470596326675b5d6ba5bb9565c618666e9ee44026c163361c7bd  opencode-linux-x64.tar.gz" \
  | sha256sum -c -

# macOS: no installer-compatible archive exists for v1.1.1 (only .zip,
# which setupOpenCode() never requests), so there is nothing to verify.
# For reference, the published .zip blobs can be checked manually:
# curl -sL -o opencode-darwin-arm64.zip \
#   https://github.com/anomalyco/opencode/releases/download/v1.1.1/opencode-darwin-arm64.zip
# shasum -a 256 opencode-darwin-arm64.zip
# compare against 880c1bdbbb6dedf41089c509e8a8a5516b7358b181e5dda8213c2b90985b4332
# (x64: opencode-darwin-x64.zip compares against
# 684c948c88a7043671c7689b92b6657f671e007c1dbea23e9072a6ec8078cc78)
```

`parseChecksumFile()` (`lib/src/utils/checksum.ts`) documents the
`SHA256SUMS`-style line format (`<hex>  <filename>`, `*` binary-marker and
`./` prefixes accepted) used when a release *does* publish a checksum file.

## Opt-in enforcement: `require_opencode_checksum`

The existing action input (NOT a `security:` config key) turns a missing
checksum into a hard error. Default `true` in the Action — pin
`opencode_version` to a checksummed release (below) or set
`require_opencode_checksum: 'false'` to restore the fail-open
warn-and-continue behavior.

```yaml
- uses: nilesh32236/opencode-ai-reviewer@v1.22.1
  with:
    opencode_version: 'v1.18.35' # pin to a checksummed release
    require_opencode_checksum: 'true'
```

Behavior (`verifyDownloadedArchive()` in `lib/src/opencode.ts`):

- Enforcement **off** (explicit opt-out: `require_opencode_checksum: 'false'`
  in the Action, `{ requireChecksum: false }` or
  `INPUT_REQUIRE_OPENCODE_CHECKSUM=false` in `lib`), unknown
  version / no checksum asset: warn-and-continue.
- Enforcement **on**, no repository-controlled expected hash (no checksum
  asset entry, no `KNOWN_CHECKSUMS` hit, and no release asset `digest`): fail
  closed via `buildMissingChecksumError()`. A release asset `digest` is
  verified for transport integrity but is **not** accepted as a substitute: it
  is served by the same release as the archive, so under strict enforcement an
  unpinned version still fails closed. To fix, pin `opencode_version` to a
  pinned version in the tables above covering your
  arch (linux-x64, linux-arm64, windows-x64 for 1.1.1; linux-x64, linux-arm64,
  windows-x64, windows-arm64 for 1.18.31 and 1.18.35; no darwin pin exists for any).
  Strict enforcement is currently unsatisfiable on darwin-x64/darwin-arm64 for
  both pins (and on windows-arm64 for 1.1.1) — a macOS runner following this
  guidance has no valid pin and will hit the fail-closed error naming the
  unsupported arch. Only as a last resort, and at
  your own risk (this disables integrity protection), re-run with
  enforcement off while you obtain the expected sha256 out-of-band.
- **Checksum mismatch always aborts** via `verifyChecksum()` in either mode
  (`Checksum mismatch … expected …, got …`), tagged non-retryable so the
  download is not retried with backoff.
- Checksum-file fetch failure: the download falls through to the
  `KNOWN_CHECKSUMS` pinned lookup; warn-and-continue unless enforcement is on
  and no pinned entry verifies (then fail closed).
- Scope note: strict mode fails closed for **fresh downloads, unattested
  pre-installed `PATH` binaries, and tool-cache hits**. A binary already on
  `PATH` is accepted without a fresh download only when its on-disk sha256
  matches the build-time attestation: the Docker build verifies the release
  archive (`sha256sum -c`) and records the installed binary's sha256 in
  `/usr/local/share/opencode/install-digest` (copied into the runtime image;
  `OPENCODE_EXPECTED_SHA256` env var takes precedence when set). An
  unattested or mismatched PATH binary throws instead of silently passing
  the gate — remove the pre-installed binary so a fresh verified download
  runs, or (container images) ensure the attestation manifest ships with the
  image. A cached entry (whose `.checksum` is self-recorded, not
  independently verified) throws — clear the tool cache so a fresh verified
  download runs.

## Build-time attestation (`/usr/local/share/opencode/install-digest`)

The container image installs exactly one `opencode` binary: the builder
verifies the release archive against the pinned `OPENCODE_SHA256` and then
records `sha256sum /usr/local/bin/opencode` into
`/usr/local/share/opencode/install-digest` (see `docker/Dockerfile`). At
runtime `setupOpenCode()` / `resolveOpenCodePath()` hash the PATH binary
and accept it only on an exact match (`readAttestedDigest()` /
`verifyPathBinaryAttestation()` in `lib/src/opencode.ts`). A missing
manifest or a mismatched hash fails closed with the attestation remedy
named first. `OPENCODE_INSTALL_DIGEST_PATH` overrides the manifest location
(primarily a test hook). Treat it as equivalent to disabling integrity
protection in production: whoever controls that env var controls the
attestation trust anchor, and using it outside tests emits a warning.
The same applies to `OPENCODE_EXPECTED_SHA256`: using the env-var anchor
outside tests emits a warning, and a set-but-malformed env value fails
closed (no attestation) instead of falling through to the manifest, so an
operator typo cannot silently change precedence. Fallback hex extraction
requires non-hex boundaries so a 64-char substring of a longer hex token
is never accepted as the digest.
The attested digest is cached per process; the manifest is parsed at most
once. The PATH binary is hashed via its canonical `realpath`; a residual
hash-then-exec TOCTOU window (swap between verification and spawn) is
accepted risk — it needs write access to the binary location and is narrow
in ephemeral CI. Both `setupOpenCode()` and `resolveOpenCodePath()` share
one attested-PATH gate (`resolveAttestedPathBinary()`), so an
attested-but-stale binary fails the minimum-version health check via either
entry point.

Maintainers: record newly verified hashes in `KNOWN_CHECKSUMS`
(`lib/src/utils/checksum.ts`, key `<version>-<arch>`, no leading `v`) and add
a row to the table above.

## Attestation / provenance

- GitHub Actions hardening (verify downloaded binaries):
  https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions
- SLSA attestation model (build provenance):
  https://slsa.dev/attestation-model
- Release assets + per-asset `digest` (source of the tables above):
  https://github.com/anomalyco/opencode/releases
  (API: `GET /repos/anomalyco/opencode/releases/tags/v1.1.1`,
  `GET /repos/anomalyco/opencode/releases/tags/v1.18.31`,
  `GET /repos/anomalyco/opencode/releases/tags/v1.18.35`;
  cross-checked against `GET /repos/sst/opencode/releases/tags/v1.18.31`)
