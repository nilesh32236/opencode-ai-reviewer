# Audit: Kubernetes Security

You are auditing Kubernetes manifests for workload and cluster security misconfigurations. Focus on pod security contexts, resource management, and network controls.

> **Reachability Context:** After this audit, a lightweight reachability analysis will run on each finding. Findings flagged in code that is not reachable from an HTTP handler, CLI entry point, message consumer, or other user-input source will be automatically tagged as `theoreticalRisk: true`. You should still report all potential vulnerabilities — the reachability pass will handle classification.

## What to Check

Scan files matching `*.yaml` or `*.yml` that contain Kubernetes `apiVersion:` (e.g., `apps/v1`, `v1`, `batch/v1`).

### Privileged Containers
- `securityContext.privileged: true` — grants unrestricted host access
- `securityContext.allowPrivilegeEscalation: true`

### Root Containers
- `securityContext.runAsUser: 0` or missing `runAsNonRoot: true`
- Missing `securityContext.runAsUser` in the pod or container spec
- Missing `securityContext.runAsGroup` (non-root group) in the pod or container spec

### Container Capabilities
- Containers that do not drop all capabilities with `capabilities.drop: ["ALL"]`
- `capabilities.add` including `SYS_ADMIN`, `NET_ADMIN`, or `ALL`

### Pod Security Context
- Missing `securityContext.seccompProfile` or seccompProfile set to `Unconfined` (should use `RuntimeDefault`)
- Missing `securityContext.readOnlyRootFilesystem: true` for hardened containers
- `securityContext.runAsUser: 0` or missing non-root user/group settings

### Resource Limits
- Missing `resources.limits.cpu` or `resources.limits.memory`
- Missing `resources.requests.cpu` or `resources.requests.memory`
- Resources with no limits defined (risk of resource exhaustion)

### Host Access
- `hostNetwork: true` — container can access host networking
- `hostPID: true` — container can see host processes
- `hostIPC: true` — container can access host IPC resources

### HostPath Volumes
- Pods with `hostPath` volumes that mount sensitive host directories
- `path: /`, `path: /var/run/docker.sock`, `path: /proc`, `path: /etc`

### Network Policies
- Missing `NetworkPolicy` resources for namespaces
- Namespace without network isolation (pods can communicate freely)

### Image Security
- `imagePullPolicy: Never` — may cause pod failures on node restart
- Container images using `:latest` tag
- Missing `imagePullPolicy: Always` (or appropriate policy for the deployment strategy)

## Output Format

Write findings to the output file in JSON Lines format:

```jsonl
{"type":"summary","text":"Audited {target_dir}. Found X issues."}
{"type":"issue","severity":"critical|important|minor","file":"relative/path","line":42,"message":"What the issue is","suggestion":"How to fix it","inline":false}
```
Note: Findings will be post-processed for reachability — you do not need to include `theoreticalRisk` or `entryPointPath` in your output. Focus on correctly identifying the misconfiguration and its location.

## Severity Guide

- **critical**: Privileged containers, host network/pid/ipc access, hostPath to docker socket or root
- **important**: Containers running as root, missing resource limits, `:latest` tag, missing network policies
- **minor**: Missing `runAsNonRoot`, `imagePullPolicy: Never`, missing capability drops
