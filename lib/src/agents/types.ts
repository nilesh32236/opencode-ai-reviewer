// Shared abstractions for the multi-agent review architecture.
// Agents are specialized prompt builders + output parsers that reuse the
// existing OpenCode subprocess infrastructure — they are not separate
// processes or services (see issue #200, Option A).

import type {
  AgentCategory,
  AgentResult,
  PromptBuilderInputs,
} from '../types/index.js';

export type { AgentCategory, AgentResult } from '../types/index.js';

/** Context inputs shared by every specialized agent prompt builder. */
export interface AgentPromptContext {
  /** Configuration inputs (project context, custom prompt file, etc.). */
  inputs: PromptBuilderInputs;
  /** The PR/base context string describing the pull request. */
  prContext: string;
}

/**
 * A specialized review agent: a focused prompt builder plus a parser that
 * converts the agent's raw JSONL output into a structured AgentResult.
 */
export interface SpecializedAgent {
  /** The domain category this agent is responsible for. */
  category: AgentCategory;
  /** Human-readable agent name (e.g. "Security Agent"). */
  name: string;
  /** Build the agent-specific review prompt for the given context. */
  buildPrompt(context: AgentPromptContext): string;
  /** Parse the agent's raw JSONL output into a structured result. */
  parseOutput(rawJsonl: string): AgentResult;
}

/**
 * Runs a specialized agent against a set of files and returns its findings.
 * Implementations reuse the shared `runOpenCode` infrastructure with the
 * agent's own prompt and optional model override.
 */
export interface AgentRunner {
  /**
   * Execute a specialized agent review pass.
   * @param category - The agent category to run.
   * @param files - The files (subset of the PR diff) the agent reviews.
   * @param context - The base PR context string.
   * @param config - Multi-agent configuration for model/prompt overrides.
   * @returns The agent's structured result.
   */
  runAgent(
    category: AgentCategory,
    files: Array<{ path?: string; patch?: string }>,
    context: string,
    config: Record<string, unknown>,
  ): Promise<AgentResult>;
}
