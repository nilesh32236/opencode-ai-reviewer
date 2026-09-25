#!/usr/bin/env bash
# SEC-001 artifact boundary: create and validate untrusted patch/status artifacts.
# This helper is used only in agent/verification jobs or in a fresh trusted
# main checkout before credentials are introduced. It never contacts GitHub.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  sec001-artifact.sh create --output DIR --run-id ID --base-sha SHA --attempt N --phase PHASE [--allow-prefix P]...
  sec001-artifact.sh validate --artifact DIR --expected-run-id ID --expected-base-sha SHA --expected-attempt N --expected-phase PHASE [--allow-prefix P]...
  sec001-artifact.sh apply --artifact DIR --expected-run-id ID --expected-base-sha SHA --expected-attempt N --expected-phase PHASE [--allow-prefix P]...
  sec001-artifact.sh status --output DIR --run-id ID --base-sha SHA --phase PHASE --verified true|false --log FILE
  sec001-artifact.sh wrap --output DIR --input FILE --name NAME --run-id ID --base-sha SHA --phase PHASE
  sec001-artifact.sh validate-wrap --artifact DIR --expected-run-id ID --expected-base-sha SHA --expected-phase PHASE
  sec001-artifact.sh scan-tree --input DIR
EOF
  exit 2
}

command_name="${1:-}"
[ -n "$command_name" ] || usage
shift || true

OUTPUT=''; ARTIFACT=''; RUN_ID=''; BASE_SHA=''; ATTEMPT=''; PHASE=''; VERIFIED=''; LOG_FILE=''; INPUT_FILE=''; FILE_NAME='payload.json'
ALLOW_PREFIXES=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) OUTPUT="${2:-}"; shift 2 ;;
    --artifact) ARTIFACT="${2:-}"; shift 2 ;;
    --run-id|--expected-run-id) RUN_ID="${2:-}"; shift 2 ;;
    --base-sha|--expected-base-sha) BASE_SHA="${2:-}"; shift 2 ;;
    --attempt|--expected-attempt) ATTEMPT="${2:-}"; shift 2 ;;
    --phase|--expected-phase) PHASE="${2:-}"; shift 2 ;;
    --verified) VERIFIED="${2:-}"; shift 2 ;;
    --log) LOG_FILE="${2:-}"; shift 2 ;;
    --input) INPUT_FILE="${2:-}"; shift 2 ;;
    --name) FILE_NAME="${2:-}"; shift 2 ;;
    --allow-prefix) ALLOW_PREFIXES+=("${2:-}"); shift 2 ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

fail() { echo "SEC-001 artifact: $*" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"; }
require_command jq
require_command sha256sum
require_command git
require_command mktemp

safe_path() {
  local path="$1"
  case "$path" in
    ''|/*|../*|*/../*|*/..|..|.git|.git/*|*.env|*.pem|*.key|*.p12|*.pfx|*.crt|*.cer|id_rsa*|.ssh/*) return 1 ;;
  esac
  [[ "$path" != *'\\'* && "$path" != *$'\t'* ]]
}

path_allowed() {
  local path="$1" prefix
  safe_path "$path" || return 1
  [ "${#ALLOW_PREFIXES[@]}" -gt 0 ] || return 0
  for prefix in "${ALLOW_PREFIXES[@]}"; do
    [ -n "$prefix" ] || continue
    case "$path" in "$prefix"*) return 0 ;; esac
  done
  return 1
}

reject_secret_content() {
  local target="$1" pattern
  pattern='(github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'
  if [ -f "$target" ]; then
    if grep -InaE "$pattern" "$target" >/dev/null 2>&1; then fail 'credential-shaped content is prohibited in an artifact'; fi
  elif grep -RInaE --exclude='*.tar.gz' --exclude='*.zip' "$pattern" "$target" >/dev/null 2>&1; then
    fail 'credential-shaped content is prohibited in an artifact'
  fi
}

scan_tree() {
  local target="$1"
  [ -d "$target" ] && [ ! -L "$target" ] || fail 'artifact scan target is missing or is a symlink'
  if find "$target" -type l -print -quit | grep -q .; then fail 'symlinks are prohibited in artifact trees'; fi
  reject_secret_content "$target"
}

validate_scalar_metadata() {
  local metadata="$1"
  jq -e '
    type == "object" and
    (.run_id | type == "string" and length > 0) and
    (.base_sha | test("^[0-9a-f]{40}$")) and
    (.attempt | type == "number" and . >= 1) and
    (.phase | type == "string" and length > 0) and
    (.changed_files | type == "array") and
    (.byte_count | type == "number" and . >= 0) and
    (.sha256 | test("^[0-9a-f]{64}$"))
  ' "$metadata" >/dev/null || fail 'invalid artifact metadata schema'
  jq -e --arg run "$RUN_ID" --arg base "$BASE_SHA" --argjson attempt "$ATTEMPT" --arg phase "$PHASE" '
    .run_id == $run and .base_sha == $base and .attempt == $attempt and .phase == $phase
  ' "$metadata" >/dev/null || fail 'artifact metadata does not match expected run/base/attempt/phase'
}

validate_patch() {
  local artifact="$1"
  local metadata="$artifact/metadata.json"
  local patch="$artifact/patch.diff"
  local files="$artifact/files.txt"
  [ -f "$metadata" ] || fail 'metadata.json is missing'
  [ -f "$patch" ] || fail 'patch.diff is missing'
  [ -f "$files" ] || fail 'files.txt is missing'
  [ ! -L "$artifact" ] || fail 'artifact directory must not be a symlink'
  validate_scalar_metadata "$metadata"

  local actual_sha actual_bytes
  actual_sha=$(sha256sum "$patch" | awk '{print $1}')
  actual_bytes=$(wc -c < "$patch" | tr -d ' ')
  jq -e --arg sha "$actual_sha" --argjson bytes "$actual_bytes" '.sha256 == $sha and .byte_count == $bytes' "$metadata" >/dev/null || fail 'patch checksum or byte count mismatch'
  [ "$(git rev-parse HEAD)" = "$BASE_SHA" ] || fail "artifact base SHA does not match checkout HEAD ($BASE_SHA)"
  grep -Eq '^(new|deleted) mode 120000' "$patch" && fail 'symlink changes are prohibited'
  reject_secret_content "$patch"

  local tmp_files
  tmp_files=$(mktemp)
  trap 'rm -f "$tmp_files"' RETURN
  git apply --numstat "$patch" | awk -F '\t' 'NF >= 3 {print $3}' | LC_ALL=C sort -u > "$tmp_files"
  local listed
  listed=$(mktemp)
  trap 'rm -f "$tmp_files" "$listed"' RETURN
  LC_ALL=C sort -u "$files" > "$listed"
  cmp -s "$tmp_files" "$listed" || fail 'files.txt does not exactly match patch paths'
  jq -e --rawfile files "$files" '.changed_files == ($files | split("\n") | map(select(length > 0)) | unique)' "$metadata" >/dev/null || fail 'metadata changed_files does not match files.txt'
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    path_allowed "$path" || fail "path is outside the approved artifact scope: $path"
  done < "$listed"
  git apply --check "$patch" || fail 'patch does not apply cleanly to the pinned base'
}

create_patch() {
  [ -n "$OUTPUT" ] && [ -n "$RUN_ID" ] && [ -n "$BASE_SHA" ] && [ -n "$ATTEMPT" ] && [ -n "$PHASE" ] || usage
  mkdir -p "$OUTPUT"
  [ ! -L "$OUTPUT" ] || fail 'output directory must not be a symlink'
  local root current
  root=$(git rev-parse --show-toplevel)
  current=$(git rev-parse HEAD)
  [ "$current" = "$BASE_SHA" ] || fail "requested base SHA $BASE_SHA does not match checkout HEAD $current"
  (cd "$root" && git add -N -- . >/dev/null 2>&1 || true)
  local files patch
  files=$(mktemp); patch="$OUTPUT/patch.diff"
  trap 'rm -f "$files"' RETURN
  git diff --name-only -z HEAD -- | while IFS= read -r -d '' path; do printf '%s\n' "$path"; done | LC_ALL=C sort -u > "$files"
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    path_allowed "$path" || fail "changed path is outside the approved artifact scope: $path"
    [ ! -L "$root/$path" ] || fail "symlink changes are prohibited: $path"
  done < "$files"
  cp "$files" "$OUTPUT/files.txt"
  git diff --binary --full-index --no-ext-diff HEAD -- > "$patch"
  reject_secret_content "$patch"
  local sha bytes
  sha=$(sha256sum "$patch" | awk '{print $1}')
  bytes=$(wc -c < "$patch" | tr -d ' ')
  jq -n --arg run "$RUN_ID" --arg base "$BASE_SHA" --argjson attempt "$ATTEMPT" --arg phase "$PHASE" --rawfile files "$files" --arg sha "$sha" --argjson bytes "$bytes" '{run_id:$run,base_sha:$base,attempt:$attempt,phase:$phase,changed_files:($files|split("\n")|map(select(length>0))|unique),byte_count:$bytes,sha256:$sha}' > "$OUTPUT/metadata.json"
}

create_status() {
  [ -n "$OUTPUT" ] && [ -n "$RUN_ID" ] && [ -n "$BASE_SHA" ] && [ -n "$PHASE" ] && [ -n "$VERIFIED" ] || usage
  case "$VERIFIED" in true|false) ;; *) fail '--verified must be true or false' ;; esac
  mkdir -p "$OUTPUT"
  [ ! -L "$OUTPUT" ] || fail 'output directory must not be a symlink'
  [ -f "$LOG_FILE" ] || fail "verification log is missing: $LOG_FILE"
  cp "$LOG_FILE" "$OUTPUT/verification.log"
  reject_secret_content "$OUTPUT/verification.log"
  local sha bytes
  sha=$(sha256sum "$OUTPUT/verification.log" | awk '{print $1}')
  bytes=$(wc -c < "$OUTPUT/verification.log" | tr -d ' ')
  jq -n --arg run "$RUN_ID" --arg base "$BASE_SHA" --arg phase "$PHASE" --argjson verified "$VERIFIED" --arg sha "$sha" --argjson bytes "$bytes" '{run_id:$run,base_sha:$base,phase:$phase,verified:$verified,changed_files:[],byte_count:$bytes,sha256:$sha}' > "$OUTPUT/status.json"
  cp "$OUTPUT/status.json" "$OUTPUT/metadata.json"
}

validate_wrapper() {
  local artifact="$1" metadata="$1/metadata.json" files="$1/files.txt"
  [ -f "$metadata" ] && [ -f "$files" ] || fail 'wrapper metadata or file list is missing'
  [ ! -L "$artifact" ] || fail 'wrapper artifact directory must not be a symlink'
  jq -e --arg run "$RUN_ID" --arg base "$BASE_SHA" --arg phase "$PHASE" '
    type == "object" and (.run_id == $run) and (.base_sha == $base) and (.phase == $phase)
    and (.changed_files | type == "array" and length == 1)
    and (.byte_count | type == "number" and . >= 0)
    and (.sha256 | test("^[0-9a-f]{64}$"))
  ' "$metadata" >/dev/null || fail 'wrapper metadata schema mismatch'
  local name sha bytes
  name=$(head -n1 "$files"); [ "$(wc -l < "$files")" -eq 1 ] || fail 'wrapper file list must contain one file'
  safe_path "$name" || fail 'wrapper payload name is unsafe'
  [ -f "$artifact/$name" ] && [ ! -L "$artifact/$name" ] || fail 'wrapper payload is missing or is a symlink'
  sha=$(sha256sum "$artifact/$name" | awk '{print $1}')
  bytes=$(wc -c < "$artifact/$name" | tr -d ' ')
  jq -e --arg sha "$sha" --argjson bytes "$bytes" --arg name "$name" '.sha256 == $sha and .byte_count == $bytes and .changed_files == [$name]' "$metadata" >/dev/null || fail 'wrapper checksum or payload mismatch'
}

create_wrapper() {
  [ -n "$OUTPUT" ] && [ -n "$INPUT_FILE" ] && [ -n "$RUN_ID" ] && [ -n "$BASE_SHA" ] && [ -n "$PHASE" ] || usage
  safe_path "$FILE_NAME" || fail 'wrapper payload name is unsafe'
  [ -f "$INPUT_FILE" ] && [ ! -L "$INPUT_FILE" ] || fail 'wrapper input is missing or is a symlink'
  mkdir -p "$OUTPUT"
  [ ! -L "$OUTPUT" ] || fail 'output directory must not be a symlink'
  cp "$INPUT_FILE" "$OUTPUT/$FILE_NAME"
  reject_secret_content "$OUTPUT/$FILE_NAME"
  printf '%s\n' "$FILE_NAME" > "$OUTPUT/files.txt"
  local sha bytes
  sha=$(sha256sum "$OUTPUT/$FILE_NAME" | awk '{print $1}')
  bytes=$(wc -c < "$OUTPUT/$FILE_NAME" | tr -d ' ')
  jq -n --arg run "$RUN_ID" --arg base "$BASE_SHA" --arg phase "$PHASE" --arg sha "$sha" --argjson bytes "$bytes" --arg name "$FILE_NAME" '{run_id:$run,base_sha:$base,phase:$phase,changed_files:[$name],byte_count:$bytes,sha256:$sha}' > "$OUTPUT/metadata.json"
}

case "$command_name" in
  create) create_patch ;;
  validate) [ -n "$ARTIFACT" ] || usage; validate_patch "$ARTIFACT" ;;
  apply)
    [ -n "$ARTIFACT" ] || usage
    validate_patch "$ARTIFACT"
    git apply --index --binary "$ARTIFACT/patch.diff"
    ;;
  status) create_status ;;
  wrap) create_wrapper ;;
  validate-wrap) [ -n "$ARTIFACT" ] || usage; validate_wrapper "$ARTIFACT" ;;
  scan-tree) [ -n "$INPUT_FILE" ] || usage; scan_tree "$INPUT_FILE" ;;
  *) usage ;;
esac
