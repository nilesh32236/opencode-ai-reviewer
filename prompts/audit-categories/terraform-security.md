# Audit: Terraform Security

You are auditing Terraform configurations for infrastructure security misconfigurations. Focus on cloud provider risks, data exposure, and compliance violations.

> **Reachability Context:** After this audit, a lightweight reachability analysis will run on each finding. Findings flagged in code that is not reachable from an HTTP handler, CLI entry point, message consumer, or other user-input source will be automatically tagged as `theoreticalRisk: true`. You should still report all potential vulnerabilities — the reachability pass will handle classification.

## What to Check

Scan files matching `*.tf` or `*.tfvars`.

### Hardcoded Secrets
- Plaintext passwords, access keys, secret keys, or tokens in resource definitions or variables
- `variable` blocks without `sensitive = true`
- Terraform state files that may contain secrets

### S3 Bucket Security
- `acl = "public-read"` or `acl = "public-read-write"`
- Missing `block_public_acls`, `block_public_policy`, `ignore_public_acls`, or `restrict_public_buckets`
- `aws_s3_bucket` without a `aws_s3_bucket_public_access_block` resource

### IAM Policies
- IAM policy documents with `"Resource": "*"` or wildcard `"Action": "*"`
- Overly permissive `Principal` (e.g., `"*"`)
- Missing `aws_iam_role` least-privilege constraints

### Encryption
- `encrypt = false` on RDS, EBS, or S3 resources
- Missing `kms_key_id` for encryption-at-rest
- `aws_db_instance` without `storage_encrypted = true`

### Versioning
- `versioning { enabled = false }` or missing `versioning` block on S3 buckets
- State-critical resources without versioning enabled

### Network Security
- Missing `network_acl` or `security_group` rules restricting ingress/egress
- `cidr_blocks = ["0.0.0.0/0"]` for sensitive services (databases, admin panels)
- `ingress` with `from_port = 0` and `to_port = 0` and `protocol = "-1"`

### Default VPC
- Using `aws_default_vpc` instead of creating a dedicated VPC
- Resources deployed into `default` VPC without explicit justification

## Output Format

Write findings to the output file in JSON Lines format:

```jsonl
{"type":"summary","text":"Audited {target_dir}. Found X issues."}
{"type":"issue","severity":"critical|important|minor","file":"relative/path","line":42,"message":"What the issue is","suggestion":"How to fix it","inline":false}
```
Note: Findings will be post-processed for reachability — you do not need to include `theoreticalRisk` or `entryPointPath` in your output. Focus on correctly identifying the misconfiguration and its location.

## Severity Guide

- **critical**: Hardcoded secrets, S3 bucket open to public, IAM wildcard actions, encryption disabled
- **important**: Missing versioning on state resources, default VPC usage, overly permissive security groups
- **minor**: Missing `sensitive = true` on variables, missing network ACLs, non-blocking config drift
