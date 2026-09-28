#!/usr/bin/env bash
# Shared SEC-001 candidate path policy. Sourced by artifact creation and
# publish-time validation so the two trust boundaries cannot drift.
sec001_path_component_safe() {
  local part="$1" lower
  lower="${part,,}"
  case "$lower" in
    ''|.|..|.git|.ssh|.env|.env.*|id_rsa*|*.pem|*.key|*.p12|*.pfx|*.crt|*.cer|*.npmrc|.pypirc|secrets.*) return 1 ;;
  esac
  return 0
}

sec001_path_is_safe() {
  local path="$1" part old_ifs
  case "$path" in ''|/*|../*|*/../*|*/..|..) return 1 ;; esac
  # '\' is the literal single backslash; '\t'/'\n'/'\r' are the control
  # characters. Using '\\' here would only match a PAIR of backslashes and let
  # a single one through.
  [[ "$path" != *'\'* && "$path" != *$'\t'* && "$path" != *$'\n'* && "$path" != *$'\r'* ]] || return 1
  old_ifs=$IFS; IFS='/' read -r -a _sec001_policy_parts <<< "$path"; IFS=$old_ifs
  for part in "${_sec001_policy_parts[@]}"; do
    sec001_path_component_safe "$part" || return 1
  done
  return 0
}

sec001_candidate_path_denied() {
  local path="$1" part lower old_ifs
  case "${path,,}" in tests/*|*/tests/*) return 1 ;; esac
  old_ifs=$IFS; IFS='/' read -r -a _sec001_policy_parts <<< "$path"; IFS=$old_ifs
  for part in "${_sec001_policy_parts[@]}"; do
    lower="${part,,}"
    case "$lower" in
      package.json|pnpm-lock.yaml|pnpm-workspace.yaml|package-lock.json|yarn.lock|tsconfig*.json|*.config.*|vitest.config.*|eslint.config.*|biome.json|.npmrc|makefile|justfile|*.test.*|*.spec.*|*.tar|*.tar.gz|*.tgz|*.zip|*.gz|*.bz2|*.xz|*.7z|*.rar|test|tests|__tests__|__mocks__|fixtures|node_modules|.pnpm|.bin) return 1 ;;
    esac
  done
  return 0
}

sec001_assert_candidate_path() {
  local path="$1"
  sec001_path_is_safe "$path" || return 1
  sec001_candidate_path_denied "$path"
}
