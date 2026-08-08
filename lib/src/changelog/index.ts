/**
 * Barrel export for the `/changelog` module.
 */

export {
  categorizePRs,
  formatMarkdown,
  formatJson,
  monorepoFilter,
  generateChangelog,
} from './generator.js';
export type { ChangelogBaseline, FormatMarkdownOptions } from './generator.js';
export type {
  MergedPR,
  ChangelogEntry,
  GitTag,
  ChangelogConfig,
  ChangelogResult,
} from './types.js';
export {
  buildChangelogFileContent,
  resolveChangelogFilePath,
} from './file-content.js';
