import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  type AgentConfig,
  DEFAULT_CONFIG,
  GitHubHelper,
  type MCPServerConfig,
  ReviewEngine,
  getDefaultMCPServers,
  validateConfig,
} from '@opencode-pr-agent/lib';
import { runAudit } from './audit';
import { runAutofixLoop, runFix } from './fix';
import { parseInputs } from './inputs';
import { runPost } from './post';
import { runReview } from './review';

async function run(): Promise<void> {
  try {
    const inputs = parseInputs();

    const repo = core.getInput('repo') || github.context.repo.repo;
    const token = inputs.githubToken;

    let mcpServers: MCPServerConfig[] = [];
    if (inputs.enableMCP) {
      const mcpServersJson = core.getInput('mcp-servers');
      if (mcpServersJson) {
        try {
          mcpServers = JSON.parse(mcpServersJson);
        } catch {
          core.warning('Invalid MCP servers JSON, using defaults');
        }
      }
      if (mcpServers.length === 0) {
        mcpServers = getDefaultMCPServers(token);
      }
    }

    const config: AgentConfig = {
      ...DEFAULT_CONFIG,
      reviewModel: inputs.reviewModel,
      fixModel: inputs.fixModel,
      batchSize: inputs.maxFilesPerBatch,
      maxIterations: inputs.maxFixIterations,
      enableMCP: inputs.enableMCP,
      mcpServers,
      projectContext: {
        description: inputs.projectContext || '',
        typecheckCommands: [],
        lintCommands: [],
      },
      review: {
        ...DEFAULT_CONFIG.review,
      },
      audit: {
        ...DEFAULT_CONFIG.audit,
      },
    };

    try {
      validateConfig(config);
    } catch (err) {
      core.setFailed(`Invalid config: ${err}`);
      return;
    }

    const engine = new ReviewEngine(config, token, repo);
    const gh = new GitHubHelper(token, repo);

    try {
      switch (inputs.mode) {
        case 'review':
          await runReview(inputs, config, engine, gh, repo);
          break;
        case 'fix':
          if (inputs.enableFix) {
            await runAutofixLoop(inputs, config, engine, gh, repo, token);
          } else {
            await runFix(inputs, config, engine, gh, repo, token);
          }
          break;
        case 'audit':
          await runAudit(inputs, config, engine, gh, repo, token);
          break;
        default:
          core.setFailed(`Unknown mode: ${inputs.mode}`);
      }
    } finally {
      await engine.cleanup();
    }
  } catch (error) {
    core.setFailed(`Action failed: ${error instanceof Error ? error.message : error}`);
  }
}

run();
