import type { LLMConfig, PromptConfig } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
/**
 * Whether a hostname is a loopback/local address where cleartext http is
 * acceptable (local dev / sidecar gateways).
 * @param hostname - Lowercased hostname from URL parsing.
 * @returns True for localhost and loopback IPs.
 */
export declare function isLoopbackHost(hostname: string): boolean;
/**
 * Whether an endpoint URL uses an allowed scheme: https always, http only for
 * loopback hosts. Unparsable URLs and non-http(s) schemes are rejected.
 * @param urlStr - Candidate endpoint URL.
 * @returns True when the scheme/host combination is acceptable.
 */
export declare function isAllowedEndpointScheme(urlStr: string): boolean;
/**
 * Build the custom LLM provider configuration for the review engine.
 *
 * TRUST BOUNDARY: the `.opencode-reviewer.yml` `llm:` section lives in the PR
 * branch, so a PR author controls it. Network destinations from the config
 * file (`baseUrl`, `endpoint`, `resourceName`) are therefore IGNORED with a
 * warning — workflow inputs (`llm_base_url`, `ollama_base_url`,
 * `azure_openai_endpoint`) are authoritative. This guarantees a
 * workflow-secret `apiKey` is never paired with a config-file-supplied host
 * (LLM prompt/diff/key exfiltration). Non-network config fields (`type`,
 * `models`, `model`, `deployment`, `modelId`, `apiVersion`, timeouts,
 * `{env:}` apiKey refs) are preserved.
 *
 * Final `baseUrl`/`endpoint` values require https (http allowed only for
 * localhost/loopback); cleartext non-local http endpoints emit a warning.
 * @param inputs - Parsed action inputs (may lack LLM fields).
 * @param loadedConfig - Parsed config file, or null.
 * @returns An LLMConfig, or undefined when nothing is configured.
 */
export declare function buildLLMConfig(inputs: ActionInputs, loadedConfig: PromptConfig | null): LLMConfig | undefined;
