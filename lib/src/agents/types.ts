// Shared abstractions for the multi-agent review architecture.
// Agents are specialized prompt builders + output parsers that reuse the
// existing OpenCode subprocess infrastructure — they are not separate
// processes or services (see issue #200, Option A).

import type { PromptBuilderInputs } from '../types/index.js';

export type { AgentCategory, AgentResult } from '../types/index.js';

/** Context inputs shared by every specialized agent prompt builder. */
export interface AgentPromptContext {
  /** Configuration inputs (project context, custom prompt file, etc.). */
  inputs: PromptBuilderInputs;
  /** The PR/base context string describing the pull request. */
  prContext: string;
}
