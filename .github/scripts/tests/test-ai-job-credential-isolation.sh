#!/usr/bin/env bash
#
# test-ai-job-credential-isolation.sh — static assertion over .github/workflows.
#
# Invariant: a step must never hold an LLM provider key AND a GitHub
# credential (GITHUB_TOKEN or a PAT) in the same `env` block. The repository
# maintains this boundary deliberately in two of its three automated workflows:
#
#   hourly-orchestrator  agent (LLM keys, no GitHub token) -> publish (PAT, no LLM keys)
#   self-improvement     agent/repair (LLM keys, no token) -> publish (GH_TOKEN only)
#
# Breaking it means model-reachable code executes in a process whose
# environment contains a write-capable credential. `upstream-monitor.yml`
# currently does (issue #937): its `create-issues` step passes both
# `GH_TOKEN` and `OPENCODE_API_KEY`, and the script it runs invokes
# `opencode run --auto` from that same environment.
#
# The check is deliberately static. The property belongs to the workflow file,
# and a runtime test could not observe it: the process either has the token in
# its environment or it does not.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

pass=0
fail=0
ok() { pass=$((pass + 1)); printf '  ok  %s\n' "$1"; }
no() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }

# Known violations, each tied to an issue. Removing an entry here is the
# deliberate act that records the fix — do NOT add a new one without an issue.
KNOWN_VIOLATIONS="upstream-monitor.yml:create-issues:Publish improvement issues"

violations() {
  python3 - "$REPO_ROOT" <<'PY'
import glob, os, re, sys, yaml

root = sys.argv[1]
LLM = re.compile(r'secrets\.([A-Z0-9_]*(?:API_KEY|TOKEN_CONTEXT7|CONTEXT7[A-Z0-9_]*))')
GH  = re.compile(r'secrets\.(GITHUB_TOKEN|GH_PAT)')
GH_ENV = re.compile(r'\$\{\{\s*secrets\.(GITHUB_TOKEN|GH_PAT)')

for path in sorted(glob.glob(os.path.join(root, '.github/workflows/*.yml'))):
    name = os.path.basename(path)
    doc = yaml.safe_load(open(path)) or {}
    for jname, job in (doc.get('jobs') or {}).items():
        for step in (job.get('steps') or []):
            step = step or {}
            env = step.get('env') or {}
            label = f"{name}:{jname}:{step.get('name') or step.get('uses') or '?'}"
            text = yaml.safe_dump(env)
            llm = LLM.search(text)
            gh  = (GH.search(text) or GH_ENV.search(text))
            if llm and gh:
                print(label)
PY
}

echo "AI job credential isolation"
echo
echo "  scanning .github/workflows for steps holding both an LLM key and a GitHub credential"
echo

found="$(violations || true)"

if [ -z "$found" ]; then
  ok "no step combines an LLM key with a GitHub credential"
else
  # Step names contain spaces, so read line by line rather than word-splitting.
  while IFS= read -r v; do
    [ -n "$v" ] || continue
    if grep -qxF "$v" <<< "$KNOWN_VIOLATIONS"; then
      ok "known violation (tracked): $v"
    else
      no "UNDECLARED violation: $v — add an issue and an entry in KNOWN_VIOLATIONS, or fix it"
    fi
  done <<< "$found"
fi

# Runs in BOTH branches: once a declared violation is fixed, the declaration
# itself becomes wrong, and leaving it would silently grandfather any future
# violation back into "known".
while IFS= read -r known; do
  [ -n "$known" ] || continue
  if ! grep -qxF "$known" <<< "$found"; then
    no "stale KNOWN_VIOLATIONS entry — '$known' no longer violates; remove the declaration"
  fi
done <<< "$KNOWN_VIOLATIONS"

echo
printf 'passed: %d  failed: %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
