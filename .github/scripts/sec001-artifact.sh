#!/usr/bin/env bash
# SEC-001 artifact boundary: create and validate untrusted patch/status artifacts.
# This helper is used only in agent/verification jobs or in a fresh trusted
# main checkout before credentials are introduced. It never contacts GitHub.
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=sec001-path-policy.sh
. "$SCRIPT_DIR/sec001-path-policy.sh"
MAX_FILE_BYTES=$((10 * 1024 * 1024))
MAX_WRAPPER_BYTES=$((5 * 1024 * 1024))
MAX_LOG_BYTES=$((2 * 1024 * 1024))
MAX_ARTIFACT_BYTES=$((20 * 1024 * 1024))
MAX_RESULTS=100
MAX_TREE_ENTRIES=10000

# Scratch files are registered globally and removed by ONE exit trap installed
# here, before any mktemp can run. A per-function `trap ... EXIT` would be
# replaced by the next function's trap, and a per-function `local` would be out
# of scope by the time the trap fired — either way the files would leak.
SEC001_SCRATCH=()
new_scratch() {
  local __name="$1" __path
  __path=$(mktemp) || return 1
  SEC001_SCRATCH+=("$__path")
  printf -v "$__name" '%s' "$__path"
}
scratch_cleanup() {
  local __p
  for __p in ${SEC001_SCRATCH[@]+"${SEC001_SCRATCH[@]}"}; do
    # `|| true` so one unremovable file cannot abort the loop and strand the
    # rest, and cannot turn a successful run into a failure.
    [ -z "$__p" ] || rm -f -- "$__p" 2>/dev/null || true
  done
  return 0
}
trap scratch_cleanup EXIT
check_file_size() { [ -f "$1" ] && [ ! -L "$1" ] || return 1; [ "$(wc -c < "$1")" -le "$2" ]; }
check_tree_size() {
  local size
  size=$(du -sb "$1" | awk '{print $1}') || return 1
  [[ "$size" =~ ^[0-9]+$ ]] || return 1
  [ "$size" -le "$MAX_ARTIFACT_BYTES" ]
}
# Repository-controlled config must never supply a Git hook, fsmonitor, or
# replacement-object command to packaging/validation. Use the runner's fixed
# Git binary and override the dangerous local settings on every invocation.
git_secure() { /usr/bin/git -c core.worktree="$START_PWD" -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.untrackedCache=false "$@"; }
while IFS='=' read -r _sec001_git_env _; do
  case "$_sec001_git_env" in
    GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS|GIT_CONFIG_KEY_*|GIT_CONFIG_VALUE_*|GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_COMMON_DIR|GIT_REPLACE_REF_BASE) unset "$_sec001_git_env" || true ;;
  esac
done < <(env)
export PATH=/usr/local/bin:/usr/bin:/bin
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0
START_PWD=$(pwd -P)

usage() {
  cat >&2 <<'EOF'
Usage:
  sec001-artifact.sh create --output DIR --run-id ID --base-sha SHA --attempt N --phase PHASE [--allow-prefix P]...
  sec001-artifact.sh validate --artifact DIR --expected-run-id ID --expected-base-sha SHA --expected-attempt N --expected-phase PHASE [--allow-prefix P]...
  sec001-artifact.sh validate-package --artifact DIR --expected-run-id ID --expected-base-sha SHA --expected-attempt N --expected-phase PHASE [--allow-prefix P]...
  sec001-artifact.sh apply --artifact DIR --expected-run-id ID --expected-base-sha SHA --expected-attempt N --expected-phase PHASE [--allow-prefix P]...
  sec001-artifact.sh status --output DIR --run-id ID --base-sha SHA --phase PHASE --verified true|false --log FILE [--status-file FILE]
  sec001-artifact.sh validate-status --artifact DIR --expected-run-id ID --expected-base-sha SHA --expected-phase PHASE
  sec001-artifact.sh wrap --output DIR --input FILE --name NAME --run-id ID --base-sha SHA --phase PHASE
  sec001-artifact.sh validate-wrap --artifact DIR --expected-run-id ID --expected-base-sha SHA --expected-phase PHASE
  sec001-artifact.sh scan-tree --input DIR
EOF
  exit 2
}

command_name="${1:-}"
[ -n "$command_name" ] || usage
shift || true

OUTPUT=''; ARTIFACT=''; RUN_ID=''; BASE_SHA=''; ATTEMPT=''; PHASE=''; VERIFIED=''; LOG_FILE=''; STATUS_FILE=''; INPUT_FILE=''; FILE_NAME='payload.json'
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
    --status-file) STATUS_FILE="${2:-}"; shift 2 ;;
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

safe_mkdir_tree() {
  /usr/bin/python3 -I - "$1" <<'PY'
import os
import sys
path = sys.argv[1]
parts = path.split(os.sep)
if not path or any(part in {'.', '..'} for part in parts) or (len(parts) > 1 and any(part == '' for part in parts[1:])):
    raise SystemExit(1)
path = os.path.abspath(path)
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, 'O_CLOEXEC', 0)
fd = os.open('/', flags)
try:
    for part in path.split(os.sep)[1:]:
        try:
            next_fd = os.open(part, flags, dir_fd=fd)
        except FileNotFoundError:
            os.mkdir(part, 0o700, dir_fd=fd)
            next_fd = os.open(part, flags, dir_fd=fd)
        os.close(fd)
        fd = next_fd
finally:
    os.close(fd)
PY
}

secure_copy_file() {
  /usr/bin/python3 -I - "$1" "$2" <<'PY'
import os
import stat
import sys
source, destination = sys.argv[1:]
flags = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, 'O_CLOEXEC', 0)
parent_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, 'O_CLOEXEC', 0)
source_parent, source_name = os.path.split(os.path.abspath(source))
source_parent_fd = os.open('/', parent_flags)
try:
    for part in [p for p in source_parent.split(os.sep) if p]:
        source_parent_fd = os.open(part, parent_flags, dir_fd=source_parent_fd)
    source_fd = os.open(source_name, flags, dir_fd=source_parent_fd)
finally:
    os.close(source_parent_fd)
try:
    info = os.fstat(source_fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise SystemExit(1)
    parent, name = os.path.split(os.path.abspath(destination))
    parent_fd = os.open('/', parent_flags)
    try:
        for part in [p for p in parent.split(os.sep) if p]:
            parent_fd = os.open(part, parent_flags, dir_fd=parent_fd)
        output_fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_CLOEXEC', 0), 0o600, dir_fd=parent_fd)
        try:
            while True:
                chunk = os.read(source_fd, 1024 * 1024)
                if not chunk:
                    break
                view = memoryview(chunk)
                while view:
                    count = os.write(output_fd, view)
                    if count <= 0:
                        raise SystemExit(1)
                    view = view[count:]
            os.fsync(output_fd)
        except BaseException:
            try:
                os.unlink(name, dir_fd=parent_fd)
            except OSError:
                pass
            raise
        finally:
            os.close(output_fd)
    finally:
        os.close(parent_fd)
finally:
    os.close(source_fd)
PY
}

safe_path() { sec001_path_is_safe "$1"; }
deny_candidate_path() { sec001_candidate_path_denied "$1"; }
path_allowed() {
  local path="$1" prefix
  safe_path "$path" || return 1
  deny_candidate_path "$path" || return 1
  [ "${#ALLOW_PREFIXES[@]}" -gt 0 ] || return 0
  for prefix in "${ALLOW_PREFIXES[@]}"; do
    [ -n "$prefix" ] || continue
    case "$prefix" in
      */)
        if [[ "$path" == "${prefix%/}"/* ]]; then return 0; fi
        ;;
      *)
        if [ "$path" = "$prefix" ]; then return 0; fi
        ;;
    esac
  done
  return 1
}

ensure_fresh_components() {
  local dir="$1"; shift
  local component
  for component in "$@"; do
    [ ! -L "$dir/$component" ] && [ ! -e "$dir/$component" ] || fail "output component exists or is a symlink: $component"
  done
}
reject_patch_modes() {
  local patch="$1" mode listing
  new_scratch listing || return 1
  if ! awk '/^(old|new|deleted)( file)? mode / {print $NF}' "$patch" > "$listing"; then
    rm -f -- "$listing"
    fail 'patch mode scan failed'
  fi
  while IFS= read -r mode; do
    case "$mode" in 100644|100755) ;; *) rm -f -- "$listing"; echo "SEC-001 artifact: unsupported patch mode $mode" >&2; exit 1 ;; esac
  done < "$listing"
  rm -f -- "$listing"
}
reject_secret_content() {
  local target="$1" pattern grep_status
  pattern='(github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|ctx7sk-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'
  if [ -f "$target" ]; then
    if grep -InaE "$pattern" "$target" >/dev/null 2>&1; then
      fail 'credential-shaped content is prohibited in an artifact'
    else
      grep_status=$?
      [ "$grep_status" -eq 1 ] || fail 'artifact content could not be scanned for credentials'
    fi
  else
    if grep -RInaE --exclude='*.tar.gz' --exclude='*.zip' "$pattern" "$target" >/dev/null 2>&1; then
      fail 'credential-shaped content is prohibited in an artifact'
    else
      grep_status=$?
      [ "$grep_status" -eq 1 ] || fail 'artifact tree could not be scanned for credentials'
    fi
  fi
}

validate_tree_entries() {
  local target="$1" entry links count=0 listing
  new_scratch listing || return 1
  if ! find "$target" -mindepth 1 -print0 > "$listing"; then
    fail 'artifact tree could not be enumerated'
  fi
  while IFS= read -r -d '' entry; do
    count=$((count + 1)); [ "$count" -le "$MAX_TREE_ENTRIES" ] || fail 'artifact tree entry count exceeds limit'
    if [ -d "$entry" ] && [ ! -L "$entry" ]; then continue; fi
    [ -f "$entry" ] && [ ! -L "$entry" ] || fail 'artifact trees may contain only regular files and directories'
    links=$(stat -c '%h' "$entry") || fail 'artifact entry metadata could not be read'
    [ "$links" -eq 1 ] || fail 'hardlinked artifact files are prohibited'
  done < "$listing"
  rm -f -- "$listing"
}
scan_tree() {
  local target="$1" symlinks
  [ -d "$target" ] && [ ! -L "$target" ] || fail 'artifact scan target is missing or is a symlink'
  new_scratch symlinks || fail 'could not create artifact scan state'
  if ! find "$target" -type l -print -quit > "$symlinks"; then
    rm -f -- "$symlinks"
    fail 'artifact symlink scan failed'
  fi
  if [ -s "$symlinks" ]; then
    rm -f -- "$symlinks"
    fail 'symlinks are prohibited in artifact trees'
  fi
  rm -f -- "$symlinks"
  validate_tree_entries "$target"
  check_tree_size "$target" || fail 'artifact exceeds size limit'
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

validate_patch_package() {
  local artifact="$1"
  local metadata="$artifact/metadata.json"
  local patch="$artifact/patch.diff"
  local files="$artifact/files.txt"
  [ -f "$metadata" ] && [ ! -L "$metadata" ] || fail 'metadata.json is missing or is a symlink'
  [ -f "$patch" ] && [ ! -L "$patch" ] || fail 'patch.diff is missing or is a symlink'
  [ -f "$files" ] && [ ! -L "$files" ] || fail 'files.txt is missing or is a symlink'
  [ ! -L "$artifact" ] || fail 'artifact directory must not be a symlink'
  validate_tree_entries "$artifact"
  local patch_listing patch_expected rename_listing
  new_scratch patch_listing; new_scratch patch_expected
  find "$artifact" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort > "$patch_listing"
  printf '%s\n' patch.diff files.txt metadata.json | LC_ALL=C sort > "$patch_expected"
  cmp -s "$patch_listing" "$patch_expected" || fail 'patch artifact contains unexpected files'
  rm -f "$patch_listing" "$patch_expected"
  check_tree_size "$artifact" || fail 'patch artifact exceeds size limit'
  check_file_size "$patch" "$MAX_FILE_BYTES" || fail 'patch exceeds file size limit'
  validate_scalar_metadata "$metadata"

  local actual_sha actual_bytes
  actual_sha=$(sha256sum "$patch" | awk '{print $1}')
  actual_bytes=$(wc -c < "$patch" | tr -d ' ')
  jq -e --arg sha "$actual_sha" --argjson bytes "$actual_bytes" '.sha256 == $sha and .byte_count == $bytes' "$metadata" >/dev/null || fail 'patch checksum or byte count mismatch'
  reject_patch_modes "$patch"
  local rename_path
  new_scratch rename_listing || return 1
  if ! sed -nE 's/^rename (from|to) //p' "$patch" > "$rename_listing"; then
    fail 'rename path scan failed'
  fi
  while IFS= read -r rename_path; do
    [ -n "$rename_path" ] || continue
    path_allowed "$rename_path" || fail "rename path is outside the approved artifact scope: $rename_path"
  done < "$rename_listing"
  rm -f -- "$rename_listing"
  reject_secret_content "$patch"

  local tmp_files listed
  new_scratch tmp_files
  new_scratch listed
  git_secure apply --numstat "$patch" | awk -F '\t' 'NF >= 3 {print $3}' | LC_ALL=C sort -u > "$tmp_files"
  LC_ALL=C sort -u "$files" > "$listed"
  cmp -s "$tmp_files" "$listed" || fail 'files.txt does not exactly match patch paths'
  jq -e --rawfile files "$files" '.changed_files == ($files | split("\n") | map(select(length > 0)) | unique)' "$metadata" >/dev/null || fail 'metadata changed_files does not match files.txt'
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    path_allowed "$path" || fail "path is outside the approved artifact scope: $path"
  done < "$listed"
}

validate_patch() {
  local artifact="$1"
  validate_patch_package "$artifact"
  local checkout_root
  checkout_root=$(git_secure rev-parse --show-toplevel)
  checkout_root=$(cd "$checkout_root" && pwd -P)
  [ "$checkout_root" = "$START_PWD" ] || fail "Git worktree root $checkout_root does not match trusted start directory $START_PWD"
  [ "$(git_secure rev-parse HEAD)" = "$BASE_SHA" ] || fail "artifact base SHA does not match checkout HEAD ($BASE_SHA)"
  git_secure apply --check "$artifact/patch.diff" || fail 'patch does not apply cleanly to the pinned base'
}

create_patch() {
  [ -n "$OUTPUT" ] && [ -n "$RUN_ID" ] && [ -n "$BASE_SHA" ] && [ -n "$ATTEMPT" ] && [ -n "$PHASE" ] || usage
  safe_mkdir_tree "$OUTPUT" || fail 'output directory could not be created safely'
  [ ! -L "$OUTPUT" ] || fail 'output directory must not be a symlink'
  ensure_fresh_components "$OUTPUT" patch.diff files.txt metadata.json
  local root current
  root=$(git_secure rev-parse --show-toplevel)
  root=$(cd "$root" && pwd -P)
  [ "$root" = "$START_PWD" ] || fail "Git worktree root $root does not match trusted start directory $START_PWD"
  current=$(git_secure rev-parse HEAD)
  [ "$current" = "$BASE_SHA" ] || fail "requested base SHA $BASE_SHA does not match checkout HEAD $current"
  (cd "$root" && git_secure add -N -- . >/dev/null 2>&1 || true)
  local files patch_tmp meta_tmp
  new_scratch files; new_scratch patch_tmp; new_scratch meta_tmp
  git_secure diff --name-only --no-renames --no-textconv -z HEAD -- | while IFS= read -r -d '' path; do printf '%s\n' "$path"; done | LC_ALL=C sort -u > "$files"
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    path_allowed "$path" || fail "changed path is outside the approved artifact scope: $path"
    [ ! -L "$root/$path" ] || fail "symlink changes are prohibited: $path"
  done < "$files"
  git_secure diff --binary --full-index --no-renames --no-ext-diff --no-textconv HEAD -- > "$patch_tmp"
  check_file_size "$patch_tmp" "$MAX_FILE_BYTES" || fail 'patch exceeds file size limit'
  reject_patch_modes "$patch_tmp"
  reject_secret_content "$patch_tmp"
  secure_copy_file "$files" "$OUTPUT/files.txt"
  secure_copy_file "$patch_tmp" "$OUTPUT/patch.diff"
  check_tree_size "$OUTPUT" || fail 'patch artifact exceeds size limit'
  local patch="$OUTPUT/patch.diff"
  local sha bytes
  reject_secret_content "$patch_tmp"
  local sha bytes
  sha=$(sha256sum "$patch_tmp" | awk '{print $1}')
  bytes=$(wc -c < "$patch_tmp" | tr -d ' ')
  jq -n --arg run "$RUN_ID" --arg base "$BASE_SHA" --argjson attempt "$ATTEMPT" --arg phase "$PHASE" --rawfile files "$files" --arg sha "$sha" --argjson bytes "$bytes" '{run_id:$run,base_sha:$base,attempt:$attempt,phase:$phase,changed_files:($files|split("\n")|map(select(length>0))|unique),byte_count:$bytes,sha256:$sha}' > "$meta_tmp"
  secure_copy_file "$meta_tmp" "$OUTPUT/metadata.json"
}

create_status() {
  [ -n "$OUTPUT" ] && [ -n "$RUN_ID" ] && [ -n "$BASE_SHA" ] && [ -n "$PHASE" ] && [ -n "$VERIFIED" ] || usage
  case "$VERIFIED" in true|false) ;; *) fail '--verified must be true or false' ;; esac
  safe_mkdir_tree "$OUTPUT" || fail 'output directory could not be created safely'
  [ ! -L "$OUTPUT" ] || fail 'output directory must not be a symlink'
  ensure_fresh_components "$OUTPUT" status.json verification.log files.txt metadata.json
  [ -f "$LOG_FILE" ] || fail "verification log is missing: $LOG_FILE"
  local status_tmp files_tmp meta_tmp
  new_scratch status_tmp; new_scratch files_tmp; new_scratch meta_tmp
  check_file_size "$LOG_FILE" "$MAX_LOG_BYTES" || fail 'verification log exceeds size limit'
  reject_secret_content "$LOG_FILE"
  secure_copy_file "$LOG_FILE" "$OUTPUT/verification.log"
  if [ -n "$STATUS_FILE" ]; then
    [ -f "$STATUS_FILE" ] && [ ! -L "$STATUS_FILE" ] || fail 'status file is missing or is a symlink'
    reject_secret_content "$STATUS_FILE"
    secure_copy_file "$STATUS_FILE" "$OUTPUT/status.json"
  else
    jq -n --arg run "$RUN_ID" --arg base "$BASE_SHA" --arg phase "$PHASE" --argjson verified "$VERIFIED" '{run_id:$run,base_sha:$base,phase:$phase,verified:$verified}' > "$status_tmp"
    secure_copy_file "$status_tmp" "$OUTPUT/status.json"
  fi
  check_file_size "$OUTPUT/status.json" "$MAX_FILE_BYTES" || fail 'status payload exceeds size limit'
  check_file_size "$OUTPUT/verification.log" "$MAX_LOG_BYTES" || fail 'verification log exceeds size limit'
  check_tree_size "$OUTPUT" || fail 'status artifact exceeds size limit'
  reject_secret_content "$OUTPUT/status.json"
  reject_secret_content "$OUTPUT/verification.log"
  printf '%s\n' status.json verification.log > "$files_tmp"
  secure_copy_file "$files_tmp" "$OUTPUT/files.txt"
  local status_sha status_bytes log_sha log_bytes aggregate_sha aggregate_bytes
  status_sha=$(sha256sum "$OUTPUT/status.json" | awk '{print $1}')
  status_bytes=$(wc -c < "$OUTPUT/status.json" | tr -d ' ')
  log_sha=$(sha256sum "$OUTPUT/verification.log" | awk '{print $1}')
  log_bytes=$(wc -c < "$OUTPUT/verification.log" | tr -d ' ')
  aggregate_sha=$(printf '%s  status.json\n%s  verification.log\n' "$status_sha" "$log_sha" | sha256sum | awk '{print $1}')
  aggregate_bytes=$((status_bytes + log_bytes))
  jq -n --arg run "$RUN_ID" --arg base "$BASE_SHA" --arg phase "$PHASE" --arg status_sha "$status_sha" --argjson status_bytes "$status_bytes" --arg log_sha "$log_sha" --argjson log_bytes "$log_bytes" --arg aggregate_sha "$aggregate_sha" --argjson aggregate_bytes "$aggregate_bytes" '{run_id:$run,base_sha:$base,phase:$phase,changed_files:["status.json","verification.log"],byte_count:$aggregate_bytes,sha256:$aggregate_sha,files:[{path:"status.json",byte_count:$status_bytes,sha256:$status_sha},{path:"verification.log",byte_count:$log_bytes,sha256:$log_sha}]}' > "$meta_tmp"
  secure_copy_file "$meta_tmp" "$OUTPUT/metadata.json"
}

validate_status() {
  local artifact="$1" metadata="$1/metadata.json" status="$1/status.json" log="$1/verification.log" files="$1/files.txt"
  [ -f "$metadata" ] && [ ! -L "$metadata" ] && [ -f "$status" ] && [ ! -L "$status" ] && [ -f "$log" ] && [ ! -L "$log" ] && [ -f "$files" ] && [ ! -L "$files" ] || fail 'status artifact files are missing or are symlinks'
  [ ! -L "$artifact" ] || fail 'status artifact directory is a symlink'
  local status_listing status_expected
  new_scratch status_listing; new_scratch status_expected
  find "$artifact" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort > "$status_listing"
  printf '%s\n' status.json verification.log files.txt metadata.json | LC_ALL=C sort > "$status_expected"
  cmp -s "$status_listing" "$status_expected" || fail 'status artifact contains unexpected files'
  rm -f "$status_listing" "$status_expected"
  check_tree_size "$artifact" || fail 'status artifact exceeds size limit'
  check_file_size "$status" "$MAX_FILE_BYTES" || fail 'status payload exceeds size limit'
  check_file_size "$log" "$MAX_LOG_BYTES" || fail 'verification log exceeds size limit'
  printf '%s\n' status.json verification.log | cmp -s - "$files" || fail 'status file list is invalid'
  jq -e --arg run "$RUN_ID" --arg base "$BASE_SHA" --arg phase "$PHASE" '
    type == "object" and .run_id == $run and .base_sha == $base and .phase == $phase
    and (.files | type == "array" and length == 2)
    and (.byte_count | type == "number" and . >= 0)
    and (.sha256 | test("^[0-9a-f]{64}$"))
  ' "$metadata" >/dev/null || fail 'status metadata schema mismatch'
  local status_sha status_bytes log_sha log_bytes aggregate_sha aggregate_bytes
  status_sha=$(sha256sum "$status" | awk '{print $1}'); status_bytes=$(wc -c < "$status" | tr -d ' ')
  log_sha=$(sha256sum "$log" | awk '{print $1}'); log_bytes=$(wc -c < "$log" | tr -d ' ')
  aggregate_sha=$(printf '%s  status.json\n%s  verification.log\n' "$status_sha" "$log_sha" | sha256sum | awk '{print $1}'); aggregate_bytes=$((status_bytes + log_bytes))
  jq -e --arg ssha "$status_sha" --argjson sbytes "$status_bytes" --arg lsha "$log_sha" --argjson lbytes "$log_bytes" --arg asha "$aggregate_sha" --argjson abytes "$aggregate_bytes" '.sha256 == $asha and .byte_count == $abytes and .files[0].path == "status.json" and .files[0].sha256 == $ssha and .files[0].byte_count == $sbytes and .files[1].path == "verification.log" and .files[1].sha256 == $lsha and .files[1].byte_count == $lbytes' "$metadata" >/dev/null || fail 'status checksum mismatch'
  jq -e --arg run "$RUN_ID" --arg base "$BASE_SHA" --arg phase "$PHASE" '(.run_id == $run and .base_sha == $base and .phase == $phase and ((.verified | type == "boolean") or (.verifications | type == "array")))' "$status" >/dev/null || fail 'status payload schema mismatch'
  reject_secret_content "$status"; reject_secret_content "$log"
}

validate_wrapper() {
  local artifact="$1" metadata="$1/metadata.json" files="$1/files.txt"
  [ -f "$metadata" ] && [ ! -L "$metadata" ] && [ -f "$files" ] && [ ! -L "$files" ] || fail 'wrapper metadata or file list is missing or is a symlink'
  [ ! -L "$artifact" ] || fail 'wrapper artifact directory must not be a symlink'
  check_tree_size "$artifact" || fail 'wrapper artifact exceeds size limit'
  local symlinks
  new_scratch symlinks || fail 'could not create wrapper scan state'
  if ! find "$artifact" -type l -print -quit > "$symlinks"; then rm -f -- "$symlinks"; fail 'wrapper symlink scan failed'; fi
  if [ -s "$symlinks" ]; then rm -f -- "$symlinks"; fail 'wrapper artifact contains a symlink'; fi
  rm -f -- "$symlinks"
  jq -e --arg run "$RUN_ID" --arg base "$BASE_SHA" --arg phase "$PHASE" '
    type == "object" and (.run_id == $run) and (.base_sha == $base) and (.phase == $phase)
    and (.changed_files | type == "array" and length == 1)
    and (.byte_count | type == "number" and . >= 0)
    and (.sha256 | test("^[0-9a-f]{64}$"))
  ' "$metadata" >/dev/null || fail 'wrapper metadata schema mismatch'
  local name sha bytes
  name=$(head -n1 "$files"); [ "$(wc -l < "$files")" -eq 1 ] || fail 'wrapper file list must contain one file'
  safe_path "$name" || fail 'wrapper payload name is unsafe'
  local listing expected
  new_scratch listing; new_scratch expected
  find "$artifact" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort > "$listing"
  printf '%s\n' "$name" files.txt metadata.json | LC_ALL=C sort > "$expected"
  cmp -s "$listing" "$expected" || fail 'wrapper artifact contains unexpected files'
  rm -f "$listing" "$expected"
  [ -f "$artifact/$name" ] && [ ! -L "$artifact/$name" ] || fail 'wrapper payload is missing or is a symlink'
  reject_secret_content "$artifact/$name"
  sha=$(sha256sum "$artifact/$name" | awk '{print $1}')
  bytes=$(wc -c < "$artifact/$name" | tr -d ' ')
  jq -e --arg sha "$sha" --argjson bytes "$bytes" --arg name "$name" '.sha256 == $sha and .byte_count == $bytes and .changed_files == [$name]' "$metadata" >/dev/null || fail 'wrapper checksum or payload mismatch'
}

create_wrapper() {
  [ -n "$OUTPUT" ] && [ -n "$INPUT_FILE" ] && [ -n "$RUN_ID" ] && [ -n "$BASE_SHA" ] && [ -n "$PHASE" ] || usage
  safe_path "$FILE_NAME" || fail 'wrapper payload name is unsafe'
  [ -f "$INPUT_FILE" ] && [ ! -L "$INPUT_FILE" ] || fail 'wrapper input is missing or is a symlink'
  check_file_size "$INPUT_FILE" "$MAX_WRAPPER_BYTES" || fail 'wrapper input exceeds size limit'
  safe_mkdir_tree "$OUTPUT" || fail 'output directory could not be created safely'
  [ ! -L "$OUTPUT" ] || fail 'output directory must not be a symlink'
  ensure_fresh_components "$OUTPUT" "$FILE_NAME" files.txt metadata.json
  local files_tmp meta_tmp
  new_scratch files_tmp; new_scratch meta_tmp
  # Validate the staged source before it is installed into $OUTPUT so a
  # rejected secret never persists in the published directory.
  reject_secret_content "$INPUT_FILE"
  secure_copy_file "$INPUT_FILE" "$OUTPUT/$FILE_NAME"
  printf '%s\n' "$FILE_NAME" > "$files_tmp"
  secure_copy_file "$files_tmp" "$OUTPUT/files.txt"
  local sha bytes
  sha=$(sha256sum "$OUTPUT/$FILE_NAME" | awk '{print $1}')
  bytes=$(wc -c < "$OUTPUT/$FILE_NAME" | tr -d ' ')
  jq -n --arg run "$RUN_ID" --arg base "$BASE_SHA" --arg phase "$PHASE" --arg sha "$sha" --argjson bytes "$bytes" --arg name "$FILE_NAME" '{run_id:$run,base_sha:$base,phase:$phase,changed_files:[$name],byte_count:$bytes,sha256:$sha}' > "$meta_tmp"
  secure_copy_file "$meta_tmp" "$OUTPUT/metadata.json"
}

case "$command_name" in
  create) create_patch ;;
  validate) [ -n "$ARTIFACT" ] || usage; validate_patch "$ARTIFACT" ;;
  validate-package) [ -n "$ARTIFACT" ] || usage; validate_patch_package "$ARTIFACT" ;;
  apply)
    [ -n "$ARTIFACT" ] || usage
    validate_patch "$ARTIFACT"
    git_secure apply --index --binary "$ARTIFACT/patch.diff"
    ;;
  status) create_status ;;
  validate-status) [ -n "$ARTIFACT" ] || usage; validate_status "$ARTIFACT" ;;
  wrap) create_wrapper ;;
  validate-wrap) [ -n "$ARTIFACT" ] || usage; validate_wrapper "$ARTIFACT" ;;
  scan-tree) [ -n "$INPUT_FILE" ] || usage; scan_tree "$INPUT_FILE" ;;
  *) usage ;;
esac
