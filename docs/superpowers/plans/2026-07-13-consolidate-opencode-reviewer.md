# OpenCode AI Reviewer — Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge `github-action-app/` and `opencode-ai-reviewer/` into a single monorepo with shared `lib/`, thin `action/` and `app/` wrappers, shell scripts from VMS, and reusable workflows.

**Architecture:** Monorepo with npm workspaces — `lib/` owns all shared logic (types, engine, MCP, prompts, GitHub client, JSONL parsing, OpenCode CLI), `action/` and `app/` are thin wrappers that consume `lib/`. Shell scripts handle CLI setup and context gathering for non-TypeScript workflow users.

**Tech Stack:** TypeScript 5.8, Node 20+, npm workspaces, Probot 13, Zod 3.24, MCP SDK 1.12, @actions/core/exec/github, @vercel/ncc for bundling.

## Global Constraints
- Node.js >= 20.0.0
- TypeScript target ES2022, module commonjs
- Workspace names: `@opencode-pr-agent/lib`, `@opencode-pr-agent/action`, `@opencode-pr-agent/app`
- All dependencies already declared in existing package.json files — no new dependencies introduced
- Code from VMS project adapted to remove project-specific paths (replace with variables)
- Every existing test file from both variants must continue to pass

---

### Task 1: Root Scaffolding & Config

**Files:**
- Create: `package.json` (root workspace)
- Create: `tsconfig.json` (root references)
- Create: `.eslintrc.json`
- Create: `.gitignore`
- Delete: old root files in both `github-action-app/` and `opencode-ai-reviewer/`

**Interfaces:**
- Produces: Root workspace that resolves `lib/`, `action/`, `app/` sub-packages

**Code Sources:**
- Root `package.json` from `github-action-app/package.json` (already has workspaces config)
- `.eslintrc.json` from `opencode-ai-reviewer/.eslintrc.json`
- `.gitignore` merged from both variants

- [ ] **Step 1: Create root `package.json`**

```json
{
  "name": "opencode-ai-reviewer",
  "version": "1.0.0",
  "description": "AI-powered PR review, auto-fix, and codebase audit — as a reusable GitHub Action & GitHub App",
  "private": false,
  "license": "MIT",
  "author": "nilesh32236",
  "repository": {
    "type": "git",
    "url": "https://github.com/nilesh32236/opencode-ai-reviewer"
  },
  "workspaces": [
    "lib",
    "action",
    "app"
  ],
  "scripts": {
    "build": "npm run build --workspaces",
    "test": "npm run test --workspaces",
    "lint": "eslint '*/src/**/*.ts'",
    "typecheck": "npm run typecheck --workspaces",
    "setup:local": "docker compose -f docker/docker-compose.yml up -d --build",
    "teardown:local": "docker compose -f docker/docker-compose.yml down"
  },
  "devDependencies": {
    "@types/jest": "^29.5.14",
    "@types/node": "^22.15.0",
    "eslint": "^9.16.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.3.2",
    "typescript": "^5.8.0"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

- [ ] **Step 2: Create root `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true
  },
  "references": [
    { "path": "./lib" },
    { "path": "./action" },
    { "path": "./app" }
  ]
}
```

- [ ] **Step 3: Create `.eslintrc.json`**

```json
{
  "root": true,
  "parser": "@typescript-eslint/parser",
  "parserOptions": {
    "ecmaVersion": 2022,
    "sourceType": "module"
  },
  "plugins": ["@typescript-eslint"],
  "extends": [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended"
  ],
  "rules": {
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
    "no-console": "off"
  },
  "env": {
    "node": true,
    "jest": true
  }
}
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
lib/
*.js.map
.opencode/
.audit-output.jsonl
.review-output.jsonl
.fix-stuck.md
.fix-summary.md
.env
.env.local
.secrets
*.tar.gz
.DS_Store
Thumbs.db
.vscode/
.idea/
coverage/
*.log
npm-debug.log*
```

- [ ] **Step 5: Run `npm install` at root and verify workspace resolution**

Run: `npm install`
Expected: Creates `node_modules/` at root, resolves workspace symlinks

---

### Task 2: Shared Types & Zod Schemas (`lib/src/types/`)

**Files:**
- Create: `lib/package.json`
- Create: `lib/tsconfig.json`
- Create: `lib/jest.config.js`
- Create: `lib/src/index.ts` (re-exports)
- Create: `lib/src/types/index.ts`
- Create: `lib/src/types/schemas.ts`

**Interfaces:**
- Produces: All TypeScript interfaces and Zod schemas consumed by all other tasks

**Code Source:** `github-action-app/lib/src/types/` — more comprehensive than variant 2

- [ ] **Step 1: Create `lib/package.json`**

```json
{
  "name": "@opencode-pr-agent/lib",
  "version": "1.0.0",
  "description": "Shared library for OpenCode AI Reviewer — types, engine, MCP, prompts, GitHub API",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "jest --config jest.config.js",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.1",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/jest": "^29.5.14",
    "@types/node": "^22.15.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.3.2",
    "typescript": "^5.8.0"
  }
}
```

- [ ] **Step 2: Create `lib/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "moduleResolution": "node"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `lib/jest.config.js`**

```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
};
```

- [ ] **Step 4: Create `lib/src/types/index.ts`**

Copy `github-action-app/lib/src/types/index.ts` — it has the most comprehensive type definitions including:
- `Severity`, `ReviewSummary`, `ReviewVerdict`, `ReviewStrength`, `ReviewIssue`, `ReviewEntry`
- `PRContext`, `ChangedFile`, `IssueContext`, `IssueComment`, `ReviewComment`
- `AgentConfig`, `MCPServerConfig`, `ProjectContextConfig`, `ReviewConfig`, `AuditConfig`
- `MCPContextEntry`, `MCPQueryResult`
- `ReviewInput`, `FixInput`, `AuditInput`
- `ReviewResult`, `FixResult`, `AuditResult`
- `PromptTemplate`, `PromptContext`
- `DEFAULT_CONFIG`

Remove/add: Add `ActionMode` type from variant 2 (`'review' | 'fix' | 'audit'`)

- [ ] **Step 5: Create `lib/src/types/schemas.ts`**

Copy `github-action-app/lib/src/types/schemas.ts` — it has proper Zod schemas for:
- `ReviewSummarySchema`, `ReviewVerdictSchema`, `ReviewStrengthSchema`, `ReviewIssueSchema`
- `MCPServerConfigSchema`, `ProjectContextConfigSchema`
- `ReviewConfigSchema`, `AuditConfigSchema`, `AgentConfigSchema`
- `parseReviewOutput()`, `validateConfig()`

Add: `DEFAULT_CONFIG` as a `const` from `index.ts` already — remove any duplication.

- [ ] **Step 6: Create `lib/src/index.ts`**

```typescript
export * from './types/index.js';
export * from './types/schemas.js';
export { ReviewEngine } from './engine.js';
export { reviewPromptTemplate, buildFixPrompt, buildAuditPrompt } from './prompts/builder.js';
export { MCPManager } from './mcp/client.js';
export { context7Server, githubMCPServer, getDefaultMCPServers } from './mcp/servers.js';
export { GitHubHelper } from './utils/github.js';
export { setupOpenCode, runOpenCode, ensureOutputDir, configureGit } from './opencode.js';
export { parseJsonlFile, buildReviewBody, buildInlineComments } from './jsonl-parser.js';
export { loadConfig, mergeConfigWithInputs } from './config.js';
```

- [ ] **Step 7: Run `tsc` in lib/ to verify**

Run: `cd lib && npx tsc --noEmit`
Expected: No type errors

---

### Task 3: Shared Utilities (OpenCode CLI, GitHub Helper, JSONL Parser, Config)

**Files:**
- Create: `lib/src/opencode.ts`
- Create: `lib/src/utils/github.ts`
- Create: `lib/src/jsonl-parser.ts`
- Create: `lib/src/config.ts`

**Interfaces:**
- Consumes: `types/index.ts` (PRDetails, IssueDetails, ReviewResult, ReviewPayload, ActionInputs)
- Produces: `setupOpenCode(version)`, `runOpenCode(prompt, opts)`, `configureGit(user, email, token)`, `ensureOutputDir(path)`, `GitHubHelper`, `parseJsonlFile(path)`, `buildReviewBody(result)`, `buildInlineComments(result, diffLines)`, `loadConfig(workingDir)`, `mergeConfigWithInputs(config, inputs)`

**Code Sources:**
- `opencode.ts` from `opencode-ai-reviewer/src/opencode.ts` (uses `@actions/tool-cache`, proper arch detection, `fetch` for release API)
- `github.ts` merged: variant 1's raw-fetch approach (no Octokit dependency in lib) + variant 2's richer `gatherContext()` and `closeOpenCodePRs()`
- `jsonl-parser.ts` from `opencode-ai-reviewer/src/jsonl-parser.ts` (more resilient, structured `ReviewResult` with `rawLines`/`failedLines`)
- `config.ts` from `opencode-ai-reviewer/src/config.ts` (YAML-like parser for `.opencode-reviewer.yml`)

- [ ] **Step 1: Create `lib/src/opencode.ts`**

Copy from `opencode-ai-reviewer/src/opencode.ts` and add:
- Import types from `./types/index.js` instead of local
- Keep `setupOpenCode()`, `runOpenCode()`, `configureGit()`, `ensureOutputDir()`

Key difference: `runOpenCode()` returns `{ success, output, durationMs }` — used by engine to check execution status.

- [ ] **Step 2: Create `lib/src/utils/github.ts`**

Merge from both variants:
- Use variant 1's raw `fetch()`-based API (no Octokit dependency — keeps lib lightweight)
- Add variant 2's `gatherContext()` method for full PR/issue/comment context
- Add variant 2's `postOrUpdateComment(marker)` for idempotent comments
- Add variant 2's `closeOpenCodePRs()` for cleanup
- Add variant 1's `postReview()` with inline comment fallback
- Add variant 1's label management methods
- Add variant 1's `createIssue()`, `mergePR()`, `closeIssue()`
- Remove `generateLabelColor()` — use fixed colors instead

- [ ] **Step 3: Create `lib/src/jsonl-parser.ts`**

Copy from `opencode-ai-reviewer/src/jsonl-parser.ts`:
- `parseJsonlFile(path)` — reads file, calls `parseJsonlString()`
- `parseJsonlString(content)` — line-by-line parsing, validation, returns `ReviewResult`
- `validateAndNormalize(obj)` — validates each JSONL entry
- `buildReviewBody(result)` — markdown review summary
- `buildInlineComments(result, diffLines?)` — inline comment objects for GitHub API
- `buildReviewBody()` and `buildInlineComments()` from variant 2

Update type references to use `lib/src/types/index.ts` types.

- [ ] **Step 4: Create `lib/src/config.ts`**

Copy from `opencode-ai-reviewer/src/config.ts`:
- `loadConfig(workingDir)` — scans for `.opencode-reviewer.yml/.yaml`
- `mergeConfigWithInputs(config, inputs)` — config file as defaults, action inputs override
- `validateConfig(config)` — sanitizes config values
- `extractDefaultsFromConfig()` — converts config to input-compatible defaults

- [ ] **Step 5: Verify compilation**

Run: `cd lib && npx tsc --noEmit`
Expected: No type errors

---

### Task 4: MCP Client + Servers

**Files:**
- Create: `lib/src/mcp/client.ts`
- Create: `lib/src/mcp/servers.ts`

**Interfaces:**
- Consumes: `MCPServerConfig`, `MCPContextEntry`, `MCPQueryResult`
- Produces: `MCPManager` class, `context7Server`, `githubMCPServer(token)`, `getDefaultMCPServers(token)`

**Code Source:** `github-action-app/lib/src/mcp/` — variant 2 has no MCP at all, so this comes entirely from variant 1.

- [ ] **Step 1: Create `lib/src/mcp/servers.ts`**

Copy from `github-action-app/lib/src/mcp/servers.ts` — defines:
- `context7Server`: local MCP server (`npx -y @context7/mcp-server`)
- `githubMCPServer(token)`: GitHub MCP server with GITHUB_TOKEN env
- `getDefaultMCPServers(token)`: returns both as array

- [ ] **Step 2: Create `lib/src/mcp/client.ts`**

Copy from `github-action-app/lib/src/mcp/client.ts` — `MCPManager`:
- `connect()` — initializes StdioClientTransport for each server
- `queryContext(query, maxTokens)` — queries all servers, aggregates results
- `getLibraryDocs(libraries)` — queries Context7 for specific library docs
- `disconnect()` — cleanup
- Helpers: `extractTextFromResult()`, `estimateTokens()`, `trimToTokenBudget()`

- [ ] **Step 3: Verify compilation**

Run: `cd lib && npx tsc --noEmit`
Expected: No type errors (MCP SDK types resolve from `@modelcontextprotocol/sdk`)

---

### Task 5: Prompt Builder

**Files:**
- Create: `lib/src/prompts/builder.ts`

**Interfaces:**
- Consumes: `ActionInputs`, `PromptContext`, `ProjectContextConfig`
- Produces: `buildReviewPrompt(inputs, prContext)`, `buildFixPrompt(inputs, context, iteration)`, `buildAuditPrompt(inputs, categoryPrompt, targetDir)`, `loadPromptFile(filePath)`, `loadAuditCategoryPrompt(category, promptsDir?)`, `listAuditCategories(promptsDir?)`

**Code Source:** Merge from both:
- Use variant 1's template structure (`buildPrompt` with sections) and `buildFixPrompt()`
- Use variant 2's `buildReviewPrompt()` signature (takes `ActionInputs`)
- Use variant 2's `buildAuditPrompt()` with category selection
- Keep variant 2's `loadPromptFile()`, `loadAuditCategoryPrompt()`, `listAuditCategories()`

- [ ] **Step 1: Create `lib/src/prompts/builder.ts`**

- Build review prompt using variant 1's section-based approach (role → PR context → MCP context → project context → batching → what to check → calibration → output format → rules)
- Use variant 2's parameter injection for `maxFilesPerBatch`, `includeStrengths`, `projectContext`
- Keep variant 2's `buildFixPrompt()` with iteration tracking and verification commands
- Keep variant 2's `buildAuditPrompt()` with category prompt + shared audit template
- Keep variant 2's `loadPromptFile()`, `loadAuditCategoryPrompt()`, `listAuditCategories()`

- [ ] **Step 2: Verify compilation**

Run: `cd lib && npx tsc --noEmit`
Expected: No type errors

---

### Task 6: Engine (Core Orchestrator)

**Files:**
- Create: `lib/src/engine.ts`
- Modify: `lib/src/index.ts`

**Interfaces:**
- Consumes: `AgentConfig`, `PRContext`, `GitHubHelper`, `MCPManager`, `prompt builders`, `opencode.ts`, `jsonl-parser.ts`
- Produces: `ReviewEngine` class (`reviewPR`, `runFix`, `runAudit`, `cleanup`)

**Code Source:** From `github-action-app/lib/src/engine.ts` — restructured:
- Replace `execSync` with `setupOpenCode()` + `runOpenCode()` from `opencode.ts`
- Use `parseJsonlFile()` from `jsonl-parser.ts` instead of custom `parseReviewOutput()`
- Keep MCP integration for context enrichment
- Add `detectLibraries()` from variant 1

- [ ] **Step 1: Create `lib/src/engine.ts`**

```typescript
export class ReviewEngine {
  private mcp: MCPManager;
  private github: GitHubHelper;
  private config: AgentConfig;

  constructor(config, githubToken, repo) { ... }

  async reviewPR(pr: PRContext): Promise<ReviewResult> {
    // Connect MCP → detect libraries → get docs → build prompt → run OpenCode → parse output
  }

  async runFix(prNumber, iteration, contextMarkdown): Promise<{ changesMade, stuck?, stuckReason? }> {
    // Get MCP docs → build fix prompt → run OpenCode → check git status → check stuck marker
  }

  async runAudit(promptContent, targetDir): Promise<ReviewResult> {
    // Get MCP docs → build audit prompt → run OpenCode → parse output
  }

  async cleanup(): Promise<void> {
    await this.mcp.disconnect();
  }
}
```

Use `opencode.ts`'s `setupOpenCode()` and `runOpenCode()` instead of `execSync` directly.
Use `jsonl-parser.ts`'s `parseJsonlFile()` instead of inline JSONL parsing.

- [ ] **Step 2: Update `lib/src/index.ts` to export `ReviewEngine`**

Already part of the export list from task 2 step 6 — verify it's there.

- [ ] **Step 3: Verify compilation**

Run: `cd lib && npx tsc --noEmit`
Expected: No type errors

---

### Task 7: GitHub Action Package

**Files:**
- Create: `action/action.yml`
- Create: `action/package.json`
- Create: `action/tsconfig.json`
- Create: `action/src/index.ts`
- Create: `action/src/inputs.ts`
- Create: `action/src/review.ts`
- Create: `action/src/fix.ts`
- Create: `action/src/audit.ts`
- Create: `action/src/post.ts`

**Interfaces:**
- Consumes: `@opencode-pr-agent/lib` (all shared modules)
- Produces: Compiled `dist/index.js` and `dist/post/index.js`

**Code Source:** Merge from both:
- `action.yml` — combine all input definitions from both, deduplicate
- `index.ts` — variant 2's clean dispatch (config file → parse inputs → switch(mode))
- `inputs.ts` — variant 2's comprehensive input parsing with validation
- `review.ts` — variant 2's `runReview()` with diff line validation and inline comment fallback
- `fix.ts` — variant 2's `runFix()` and `runAutofixLoop()`
- `audit.ts` — variant 2's `runAudit()` with category selection and issue creation
- `post.ts` — variant 2's post-action cleanup

- [ ] **Step 1: Create `action/action.yml`**

Merge inputs from both:
- `mode` (required), `model`, `github_token` (defaults to `github.token`)
- OpenAI/Anthropic/Google API keys (from variant 2)
- `review_prompt_file`, `review_prompt_extra`, `max_files_per_batch`, `include_strengths`, `project_context`
- `max_fix_iterations`, `auto_merge`, `run_checks_after_fix`
- `audit_prompt_file`, `audit_target_dir`, `audit_create_issues`, `audit_auto_fix`, `audit_labels`
- `opencode_version`, `working_directory`, `fail_on_critical`, `output_file`, `debug`
- From variant 1: `enable_mcp`, `mcp_servers`, `conventions_path`, `typecheck_commands`, `lint_commands`, `skip_labels`, `skip_actors`, `post_inline_comments`, `custom_rules`
- Outputs: `review_summary`, `verdict`, `critical_count`, `important_count`, `minor_count`, `output_file`

```yaml
name: 'OpenCode AI Reviewer'
description: 'AI-powered PR review, autofix loop, and codebase audit using OpenCode'
author: 'nilesh32236'
branding:
  icon: 'eye'
  color: 'purple'
inputs:
  mode:
    description: 'Operation mode: review, fix, or audit'
    required: true
    default: 'review'
  model:
    description: 'OpenCode model to use'
    required: false
    default: 'opencode/deepseek-v4-flash-free'
  github_token:
    description: 'GitHub token (defaults to GITHUB_TOKEN)'
    required: false
    default: ${{ github.token }}
  openai_api_key:
    description: 'OpenAI API key'
    required: false
  openai_base_url:
    description: 'Custom OpenAI API base URL'
    required: false
  anthropic_api_key:
    description: 'Anthropic API key'
    required: false
  google_api_key:
    description: 'Google AI API key'
    required: false
  # Review inputs
  review_prompt_file:
    description: 'Path to custom review prompt'
    required: false
  review_prompt_extra:
    description: 'Extra review instructions'
    required: false
  max_files_per_batch:
    description: 'Files per sub-agent batch'
    required: false
    default: '3'
  include_strengths:
    description: 'Include strengths in review'
    required: false
    default: 'true'
  project_context:
    description: 'Project description for prompts'
    required: false
  enable_mcp:
    description: 'Enable MCP context enrichment'
    required: false
    default: 'true'
  mcp_servers:
    description: 'JSON array of custom MCP servers'
    required: false
  conventions_path:
    description: 'Path to AGENTS.md'
    required: false
  typecheck_commands:
    description: 'Comma-separated typecheck commands'
    required: false
  lint_commands:
    description: 'Comma-separated lint commands'
    required: false
  skip_labels:
    description: 'Labels that skip review'
    required: false
    default: 'autofix,autofix:approved,autofix:merged'
  skip_actors:
    description: 'Actors that skip review'
    required: false
    default: 'github-actions[bot]'
  post_inline_comments:
    description: 'Post inline review comments'
    required: false
    default: 'true'
  custom_rules:
    description: 'Additional review rules'
    required: false
  # Fix inputs
  max_fix_iterations:
    description: 'Max review-fix iterations'
    required: false
    default: '3'
  auto_merge:
    description: 'Auto-merge approved PRs'
    required: false
    default: 'true'
  run_checks_after_fix:
    description: 'Commands to verify after fix'
    required: false
  # Audit inputs
  audit_prompt_file:
    description: 'Custom audit prompt file'
    required: false
  audit_target_dir:
    description: 'Directory to audit'
    required: false
  audit_create_issues:
    description: 'Create issues from audit findings'
    required: false
    default: 'true'
  audit_auto_fix:
    description: 'Auto-trigger fix for audit issues'
    required: false
    default: 'true'
  audit_labels:
    description: 'Labels for audit issues'
    required: false
    default: 'audit,ai-review'
  # General
  opencode_version:
    description: 'OpenCode CLI version'
    required: false
    default: 'latest'
  working_directory:
    description: 'Working directory'
    required: false
    default: '.'
  fail_on_critical:
    description: 'Fail workflow on critical issues'
    required: false
    default: 'false'
  output_file:
    description: 'JSONL output file path'
    required: false
    default: '.opencode/review-output.jsonl'
  debug:
    description: 'Enable debug logging'
    required: false
    default: 'false'
outputs:
  review_summary:
    description: 'Review summary text'
  verdict:
    description: 'Ready to merge (true/false)'
  critical_count:
    description: 'Critical issues count'
  important_count:
    description: 'Important issues count'
  minor_count:
    description: 'Minor issues count'
  output_file:
    description: 'Path to output file'
runs:
  using: 'node20'
  main: 'dist/index.js'
  post: 'dist/post/index.js'
```

- [ ] **Step 2: Create `action/package.json`**

```json
{
  "name": "@opencode-pr-agent/action",
  "version": "1.0.0",
  "description": "GitHub Action for OpenCode AI Reviewer",
  "main": "dist/index.js",
  "scripts": {
    "build": "ncc build src/index.ts --bundle --minify --outfile dist/index.js --source-map --license licenses.txt",
    "build:post": "ncc build src/post.ts --bundle --minify --outfile dist/post/index.js --source-map --license licenses.txt",
    "build:all": "npm run build && npm run build:post",
    "test": "jest --config jest.config.js",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@actions/core": "^1.11.1",
    "@actions/exec": "^1.1.1",
    "@actions/github": "^6.0.0",
    "@actions/io": "^1.1.3",
    "@actions/tool-cache": "^2.0.1",
    "@opencode-pr-agent/lib": "file:../lib"
  },
  "devDependencies": {
    "@types/node": "^22.15.0",
    "@vercel/ncc": "^0.38.3",
    "jest": "^29.7.0",
    "ts-jest": "^29.3.2",
    "typescript": "^5.8.0"
  }
}
```

- [ ] **Step 3: Create `action/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: Create `action/src/index.ts`**

Use variant 2's clean structure:
```typescript
import * as core from '@actions/core';
import { parseInputs } from './inputs';
import { loadConfig, mergeConfigWithInputs } from '@opencode-pr-agent/lib';
import { runReview } from './review';
import { runFix, runAutofixLoop } from './fix';
import { runAudit } from './audit';

async function run(): Promise<void> {
  try {
    const startTime = Date.now();
    // Load config file → merge with inputs
    const fileConfig = loadConfig(core.getInput('working_directory') || '.');
    const rawInputs = parseInputs();
    const inputs = mergeConfigWithInputs(fileConfig, rawInputs);

    core.info(`Mode: ${inputs.mode}, Model: ${inputs.model}`);

    switch (inputs.mode) {
      case 'review':
        await runReview(inputs);
        break;
      case 'fix': {
        const prNumber = require('@actions/github').context.payload?.pull_request?.number;
        if (prNumber) {
          const result = await runAutofixLoop(inputs, { prNumber });
          core.setOutput('verdict', String(result.approved));
        } else {
          await runFix(inputs, {});
        }
        break;
      }
      case 'audit':
        await runAudit(inputs);
        break;
    }

    core.info(`Completed in ${Math.round((Date.now() - startTime) / 1000)}s`);
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}
run();
```

- [ ] **Step 5: Create `action/src/inputs.ts`**

Include the `ActionInputs` and `ActionMode` types locally (they're action-specific). Use variant 2's comprehensive input parsing.

```typescript
import * as core from '@actions/core';

export type ActionMode = 'review' | 'fix' | 'audit';

export interface ActionInputs {
  mode: ActionMode;
  model: string;
  openaiApiKey: string;
  openaiBaseUrl: string;
  anthropicApiKey: string;
  googleApiKey: string;
  githubToken: string;
  reviewPromptFile: string;
  reviewPromptExtra: string;
  maxFilesPerBatch: number;
  includeStrengths: boolean;
  projectContext: string;
  enableMCP: boolean;
  mcpServers: string;
  conventionsPath: string;
  typecheckCommands: string;
  lintCommands: string;
  skipLabels: string[];
  skipActors: string[];
  postInlineComments: boolean;
  customRules: string;
  maxFixIterations: number;
  autoMerge: boolean;
  runChecksAfterFix: string;
  auditPromptFile: string;
  auditTargetDir: string;
  auditCreateIssues: boolean;
  auditAutoFix: boolean;
  auditLabels: string[];
  opencodeVersion: string;
  workingDirectory: string;
  failOnCritical: boolean;
  outputFile: string;
  debug: boolean;
}

export function parseInputs(): ActionInputs {
  const mode = core.getInput('mode', { required: true }).toLowerCase().trim();
  if (!['review', 'fix', 'audit'].includes(mode)) {
    throw new Error(`Invalid mode: "${mode}"`);
  }
  return {
    mode: mode as ActionMode,
    model: core.getInput('model') || 'opencode/deepseek-v4-flash-free',
    // ... all other inputs with validation (same structure as variant 2)
  };
}
```

- [ ] **Step 6: Create `action/src/review.ts`**

IMPORTANT: Use `GitHubHelper` from `@opencode-pr-agent/lib` (NOT variant 2's internal `GitHubClient`). The consolidated `GitHubHelper` has all the methods from both variants.
- `getPRDetails()` → use `GitHubHelper.getPR()`  
- `gatherContext()` → `GitHubHelper.gatherContext()`  
- `getDiffLines()` → `GitHubHelper.getDiffLines()`  
- `postReview()` → `GitHubHelper.postReview()`

Adapt variant 2's `review.ts` to use `GitHubHelper` instead of `GitHubClient`:
- Import from `@opencode-pr-agent/lib`: `setupOpenCode`, `runOpenCode`, `ensureOutputDir`, `configureGit`, `GitHubHelper`, `parseJsonlFile`, `buildReviewBody`, `buildInlineComments`, `buildReviewPrompt`
- Rest of the logic stays the same (context → prompt → run → parse → post)

- [ ] **Step 7: Create `action/src/fix.ts`**

Adapt variant 2's `fix.ts` to use `GitHubHelper` from `@opencode-pr-agent/lib`:
- `GitHubHelper.gatherContext()` for context
- `GitHubHelper.postOrUpdateComment()` for status updates
- `GitHubHelper.enableAutoMerge()` for auto-merge
- Import `runOpenCode`, `setupOpenCode`, `configureGit` from lib
- Keep commit/push logic same

- [ ] **Step 8: Create `action/src/audit.ts`**

Adapt variant 2's `audit.ts` to use `GitHubHelper` from `@opencode-pr-agent/lib`:
- `GitHubHelper.createIssue()` for issue creation
- `GitHubHelper.ensureLabels()` for label management
- Import `runOpenCode`, `setupOpenCode`, `configureGit`, `parseJsonlFile` from lib
- Keep category selection, prompt loading logic same

- [ ] **Step 9: Create `action/src/post.ts`**

```typescript
import * as core from '@actions/core';
async function run(): Promise<void> {
  core.info('Post-action cleanup complete.');
}
run();
```

- [ ] **Step 10: Verify build**

Run: `cd action && npm install && npm run build:all`
Expected: Creates `dist/index.js` and `dist/post/index.js` without errors

---

### Task 8: GitHub App (Probot)

**Files:**
- Create: `app/package.json`
- Create: `app/tsconfig.json`
- Create: `app/src/index.ts`
- Create: `app/src/handlers/pr-review.ts`
- Create: `app/src/handlers/autofix.ts`
- Create: `app/src/handlers/audit.ts`
- Create: `app/src/handlers/commands.ts`

**Interfaces:**
- Consumes: `@opencode-pr-agent/lib` (types, engine, GitHubHelper)
- Produces: Probot app that handles webhook events

**Code Source:** `github-action-app/app/` — variant 2 doesn't have an app.

**Key changes from original:**
- Import from `@opencode-pr-agent/lib` instead of local paths
- Use shared `ReviewEngine` from lib
- Use shared `GitHubHelper` from lib

- [ ] **Step 1: Create `app/package.json`**

```json
{
  "name": "@opencode-pr-agent/app",
  "version": "1.0.0",
  "description": "GitHub App for OpenCode AI Reviewer",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "ts-node-dev src/index.ts",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@opencode-pr-agent/lib": "file:../lib",
    "probot": "^13.4.3"
  },
  "devDependencies": {
    "@types/node": "^22.15.0",
    "ts-node-dev": "^2.0.0",
    "typescript": "^5.8.0"
  }
}
```

- [ ] **Step 2: Create `app/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `app/src/index.ts`**

Copy from `github-action-app/app/src/index.ts` — Probot entry with webhook routing:
- `pull_request.opened/synchronize` → PR review (skip bots, skip autofix)
- `issue_comment.created` → slash commands `/review`, `/fix`, `/audit`
- `issues.labeled` → `autofix-trigger` label → fix flow
- `pull_request.opened/synchronize` with `autofix` label → autofix loop

- [ ] **Step 4: Create handler files**

Copy from `github-action-app/app/src/handlers/`:
- `pr-review.ts` — review handler (already uses lib types)
- `autofix.ts` — autofix loop handler
- `audit.ts` — audit handler
- `commands.ts` — slash command dispatch

- [ ] **Step 5: Verify compilation**

Run: `cd app && npx tsc --noEmit`
Expected: No type errors

---

### Task 9: Audit Prompts (6 categories)

**Files:**
- Create: `prompts/audit-categories/api-data-fetching.md`
- Create: `prompts/audit-categories/api-endpoints.md`
- Create: `prompts/audit-categories/authentication-authorization.md`
- Create: `prompts/audit-categories/code-quality-conventions.md`
- Create: `prompts/audit-categories/security-privacy.md`
- Create: `prompts/audit-categories/ui-ux-accessibility.md`

**Code Source:** Copy from `opencode-ai-reviewer/prompts/audit-categories/`

- [ ] **Step 1: Copy all 6 prompt files**

Copy from `opencode-ai-reviewer/prompts/audit-categories/` → `prompts/audit-categories/`

---

### Task 10: Shell Scripts (from VMS)

**Files:**
- Create: `.github/scripts/setup-opencode.sh`
- Create: `.github/scripts/gather-context.sh`
- Create: `.github/scripts/post-or-update-comment.sh`
- Create: `.github/scripts/find-or-create-autofix-pr.sh`

**Code Source:** From `we-the-yuva-vms/.github/scripts/` — adapted to remove project-specific paths.

- [ ] **Step 1: Copy `setup-opencode.sh`**

From `we-the-yuva-vms/.github/scripts/setup-opencode.sh` — download/install OpenCode from GitHub releases, configure git identity, create `.opencode/` dir.

- [ ] **Step 2: Copy `gather-context.sh`**

From `we-the-yuva-vms/.github/scripts/gather-context.sh` — fetches PR/issue context via GitHub API, outputs markdown. Replace hardcoded repo paths with variables.

- [ ] **Step 3: Copy `post-or-update-comment.sh`**

From `we-the-yuva-vms/.github/scripts/post-or-update-comment.sh` — idempotent comment management via HTML markers.

- [ ] **Step 4: Copy `find-or-create-autofix-pr.sh`**

From `we-the-yuva-vms/.github/scripts/find-or-create-autofix-pr.sh` — dedup autofix PR creation, checks for existing PR by branch name (`autofix/issue-N`).

- [ ] **Step 5: Make scripts executable**

Run: `chmod +x .github/scripts/*.sh`

---

### Task 11: Reusable Workflows

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Create: `.github/workflows/codeql.yml`
- Create: `.github/workflows/review.yml` (reusable)
- Create: `.github/workflows/autofix.yml` (reusable)
- Create: `.github/workflows/audit.yml` (reusable)

**Code Source:** From `opencode-ai-reviewer/.github/workflows/` — these are the most mature reusable workflows.

- [ ] **Step 1: Create `ci.yml`**

Copy from `opencode-ai-reviewer/.github/workflows/ci.yml` — matrix test (node 20, 22), typecheck, lint, unit tests, build, verify dist.

- [ ] **Step 2: Create `release.yml`**

Copy from `opencode-ai-reviewer/.github/workflows/release.yml` — tag-based release with `softprops/action-gh-release`, includes prompt files in release assets.

- [ ] **Step 3: Create `codeql.yml`**

Copy from `opencode-ai-reviewer/.github/workflows/codeql.yml` — weekly schedule + push/PR trigger.

- [ ] **Step 4: Create `review.yml`** (reusable)

Copy from `opencode-ai-reviewer/.github/workflows/review.yml` — `workflow_call` with inputs for model, batching, fail_on_critical, project_context, API keys. Outputs: verdict, counts.

- [ ] **Step 5: Create `autofix.yml`** (reusable)

Copy from `opencode-ai-reviewer/.github/workflows/autofix.yml` — 3-job loop: review → fix → auto-merge. Job 2 (fix) runs only when review doesn't approve. Job 3 (auto-merge) runs when review approves.

- [ ] **Step 6: Create `audit.yml`** (reusable)

Copy from `opencode-ai-reviewer/.github/workflows/audit.yml` — `workflow_call` with model, prompt selection, target dir, issue creation settings.

---

### Task 12: Docker + Examples

**Files:**
- Create: `docker/Dockerfile`
- Create: `docker/docker-compose.yml`
- Create: `examples/basic/review.yml`
- Create: `examples/advanced/ai-suite.yml`
- Create: `examples/monorepo/review.yml`
- Create: `scripts/run-tests-locally.sh`
- Create: `scripts/setup.sh`

**Code Source:** From `github-action-app/docker/` and `opencode-ai-reviewer/examples/`

- [ ] **Step 1: Copy Docker files**

From `github-action-app/docker/Dockerfile` and `docker-compose.yml` — adapt to new structure.

- [ ] **Step 2: Copy example workflows**

From `opencode-ai-reviewer/examples/` — basic review, advanced suite, monorepo review.

- [ ] **Step 3: Copy setup/test scripts**

From `opencode-ai-reviewer/scripts/` — `run-tests-locally.sh`, `setup.sh`

---

### Task 13: Tests

**Files:**
- Create: `tests/fixtures/sample-review-output.jsonl`
- Create: `tests/fixtures/sample-audit-output.jsonl`
- Create: `tests/unit/inputs.test.ts`
- Create: `tests/unit/jsonl-parser.test.ts`
- Create: `tests/unit/schemas.test.ts`

**Code Source:** From both variants — merge test suites.

- [ ] **Step 1: Copy test fixtures**

Both JSONL fixtures from `opencode-ai-reviewer/tests/fixtures/`

- [ ] **Step 2: Create `tests/unit/jsonl-parser.test.ts`**

Copy from `opencode-ai-reviewer/tests/unit/jsonl-parser.test.ts` — tests parsing, validation, error handling.

- [ ] **Step 3: Create `tests/unit/inputs.test.ts`**

Copy from `opencode-ai-reviewer/tests/unit/inputs.test.ts` — tests input validation logic.

- [ ] **Step 4: Create `tests/unit/schemas.test.ts`**

Copy from `github-action-app/tests/unit/schema.test.ts` — tests Zod schema validation.

- [ ] **Step 5: Run tests**

Run: `cd lib && npm test`
Run: `cd action && npm test`
Expected: All tests pass from both variants

---

### Task 14: README

**Files:**
- Create: `README.md`
- Create: `LICENSE`

**Code Source:** Merge from both variants' READMEs.

- [ ] **Step 1: Create `README.md`**

Merge sections from both variants:
- Overview / Features (from variant 2)
- Quick Start (from variant 2)
- Configuration (inputs table from variant 1 + config file section from variant 2)
- MCP Context Enrichment section (from variant 1)
- Local Testing (from variant 1's Docker section)
- Slash Commands (from variant 1)
- Project Structure (from variant 1)
- License

- [ ] **Step 2: Create `LICENSE`**

Copy MIT license from `opencode-ai-reviewer/LICENSE`

---

### Task 15: Root-level Workspace Verification

- [ ] **Step 1: Full build from root**

Run: `npm install && npm run build`
Expected: lib/ builds → action/ builds → app/ builds, no errors

- [ ] **Step 2: Full typecheck from root**

Run: `npm run typecheck`
Expected: No type errors across all packages

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: All tests pass
