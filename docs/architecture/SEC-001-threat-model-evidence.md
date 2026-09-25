# SEC-001 threat-model evidence

**Date:** 2026-09-25
**Purpose:** document credential-free reproductions supporting the REF-006 blocker and the separate-job design.
**Status:** evidence for the approved combined SEC-001 implementation baseline.

All markers below are disposable local strings. No GitHub token, provider key, or repository credential was used.

## Reproduced properties

| Property | Experiment | Result |
|---|---|---|
| Ancestor environment visibility | Start an outer shell with `SECRET_ANCESTOR_PROBE=dummy-ancestor-marker` in its initial environment; invoke a helper script that `exec env -i ... bash`; the child reads `/proc/$PPID/environ` | `REPRODUCED`: the child recovered `SECRET_ANCESTOR_PROBE=dummy-ancestor-marker` |
| Future Bash execution state | Set `BASH_ENV` to a script that prints `BASH_ENV_POISONED`, then run `bash --noprofile --norc -e -o pipefail -c true` | `REPRODUCED`: `BASH_ENV` executed before the command body |
| Git object replacement | Create a good and replacement commit, run `git replace GOOD BAD`, then `git show GOOD:helper.sh` | `REPRODUCED`: the replacement blob was returned |
| Local remote poisoning | Set `remote.origin.url` in a temporary repository and read `git remote get-url origin` | `REPRODUCED`: the attacker-controlled URL was used by Git |
| Git command execution via config | Set `core.fsmonitor` to a temporary executable and run `git status` | `REPRODUCED`: the executable was invoked |
| Cleanup bypass | Install an `EXIT` trap and then `exec env -i ... true`; inspect the temporary HOME after exit | `REPRODUCED`: the directory survived the supposed cleanup trap |

The first direct `env -i` invocation did not show the ancestor marker because `env` was still a separate intermediary process. The faithful reproduction used a separate helper script that replaced itself with `exec`, matching the rejected workflow helper. The distinction is important: direct-child environment tests are not evidence of process-tree isolation.

The boundary suite also reproduces the publication-side races: a locally poisoned caller repository is passed to the trusted publisher with `GIT_CONFIG_COUNT`, `GIT_DIR`, hooks, and replacement refs set, while the publisher still uses its scrubbed fresh clone. A mismatched remote/repository binding, changed merge SHA, artifact symlink, unbound result, duplicate result, and queued-auto-merge fallback are all rejected. The model-wrapper test runs with a poisoned parent `BASH_ENV` marker under a neutralized workflow shell and verifies that the child allowlist contains only the selected provider/Context7 keys. Workflow packaging snapshots are changed to root-owned/read-only copies before model execution, so a same-UID model cannot replace the helper or PATH used by the packaging step.

Verification provenance is deliberately not inferred from a repository-written status file. The trusted workflow shell records the real gate command exit codes as the GitHub job conclusion. Fresh no-secret finalizer jobs run only after that conclusion is successful, validate the patch/task/result bindings and checksums, and create the canonical status consumed by credentialed publish. A schema-valid forged raw status cannot promote a failed supervisor job to success.

## Minimal reproduction shapes

```sh
# Ancestor marker must be present in the process's initial environment.
SECRET_ANCESTOR_PROBE=dummy-ancestor-marker "$OUTER_SHELL" "$HELPER"

# helper.sh must end with:
exec env -i PATH="$PATH" /bin/bash -c \
  'tr "\\0" "\\n" <"/proc/$PPID/environ" | grep SECRET_ANCESTOR_PROBE'

# BASH_ENV is consumed by noninteractive Bash before the body.
BASH_ENV="$PWN_FILE" bash --noprofile --norc -e -o pipefail -c true
```

These experiments intentionally stop at local marker creation. They do not contact GitHub or a provider and do not establish a production exploit against a real repository.

## Design consequence

A same-job `env -i` wrapper cannot satisfy the issue's threat model. The verified design must put untrusted agent/lifecycle code and any secret-bearing trusted operation on independent runners/jobs, pass only validated artifacts between them, and keep the publish job from executing repository-controlled code. See `SEC-001-job-isolation-design.md`.
