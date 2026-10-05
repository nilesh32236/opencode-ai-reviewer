/**
 * Single owner of the LLM `{env:VAR}` reference policy.
 *
 * The `llm:` block of `.opencode-reviewer.yml` is read from the PR branch, so
 * every `{env:VAR}` reference in it is attacker-controlled. Resolving one
 * against the parent process environment turns a repo-authored reference into
 * an operator secret, and the destination-stripping in `llm-endpoints.ts`
 * deliberately does not strip `apiKey` — so the guard has to live here and be
 * shared by *both* consumers:
 *
 * - `opencode.ts` (`applyLLMEnvOverrides` for the azure `apiKey`,
 *   `applyLLMEnvVarReferences` for forwarded variables)
 * - `llm-endpoints.ts` (`stripUntrustedProviderEndpoints`, which drops a
 *   preserved `apiKey` reference that is not on this allowlist)
 *
 * A copy of the list in either place is how the two drift back apart — the
 * whole reason this module exists.
 */

/**
 * Allowlist of environment variable names that may be referenced from an LLM
 * provider config via the OpenCode `{env:VAR}` substitution syntax and
 * forwarded into the sandboxed OpenCode subprocess.
 *
 * The `llm:` block is repo-controlled, so without this allowlist a
 * compromised/third-party config could reference and exfiltrate an arbitrary
 * parent env var (e.g. `{env:GITHUB_TOKEN}`) into a subprocess that renders
 * repo content into prompts/logs. Only credential names relevant to the
 * supported LLM providers are forwarded; any other reference is skipped (with
 * a warning) and the CLI's `{env:VAR}` expansion would then yield an empty
 * value for that variable.
 *
 * NOTE: AWS_* names are intentionally excluded here. Bedrock credentials flow
 * via ambient forwarding in `applyLLMEnvOverrides` (Bedrock runs only), not via
 * `{env:}` references, so a `{env:AWS_REGION}` reference warns-and-skips by
 * design — Bedrock auth still works through the ambient path.
 */
export const LLM_REF_ALLOWLIST: ReadonlySet<string> = new Set([
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'OPENAI_API_KEY',
  'OPENCODE_API_KEY',
  'OLLAMA_API_KEY',
  'OLLAMA_BASE_URL',
  'OLLAMA_MODEL',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_RESOURCE_NAME',
  'AZURE_OPENAI_API_VERSION',
]);

/** Pattern matching a whole value that is an OpenCode `{env:NAME}` reference. */
const ENV_REF_PATTERN = /^\{env:([^}]+)\}$/;

/**
 * Extract the variable name from an `{env:NAME}` reference.
 * @param value - Raw config value.
 * @returns The referenced variable name, or `undefined` when the value is not
 *   exactly one `{env:NAME}` reference.
 */
export function parseLLMEnvRef(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = ENV_REF_PATTERN.exec(value.trim());
  const name = match?.[1]?.trim();
  return name !== undefined && name !== '' ? name : undefined;
}

/**
 * Check whether a variable name may be referenced from the repo-controlled
 * `llm:` block.
 * @param name - Referenced environment variable name.
 * @returns True when the reference is allowlisted.
 */
export function isAllowedLLMRef(name: string): boolean {
  return LLM_REF_ALLOWLIST.has(name);
}
