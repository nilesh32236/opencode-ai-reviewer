import { goModule } from './go.js';
import { pythonModule } from './python.js';
import { rustModule } from './rust.js';
import { typescriptModule } from './typescript.js';

/** Programming languages that have dedicated review guidance modules. */
export type SupportedLanguage = 'rust' | 'python' | 'typescript' | 'go';

/** A per-language review guidance module injected into the review prompt. */
export interface LanguageModule {
  /** Language identifier this module applies to. */
  language: SupportedLanguage;
  /** Markdown review guidance section (without leading newline). */
  prompt: string;
}

/**
 * Default file-extension to language mapping.
 *
 * NOTE: Not yet user-configurable. To make it configurable later, thread an
 * optional extension map through `detectLanguages()` (already supported) and
 * expose it via the review config schema — no breaking change to the default path.
 */
export const EXTENSION_TO_LANGUAGE: Record<string, SupportedLanguage> = {
  '.rs': 'rust',
  '.py': 'python',
  '.pyi': 'python',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'typescript',
  '.jsx': 'typescript',
  '.mjs': 'typescript',
  '.cjs': 'typescript',
  '.go': 'go',
};

/** Registry of available language modules, keyed by language name. */
const LANGUAGE_MODULES: Record<SupportedLanguage, LanguageModule> = {
  rust: rustModule,
  python: pythonModule,
  typescript: typescriptModule,
  go: goModule,
};

/**
 * Detect the unique programming languages present in a list of file paths.
 * Extensions are matched case-insensitively against `EXTENSION_TO_LANGUAGE`
 * (or an optional custom map). Files with unknown extensions are ignored.
 * Returns languages in first-seen order across the file list, deduplicated.
 *
 * @param files - List of file paths to inspect.
 * @param extensionMap - Optional extension-to-language map overriding the default.
 * @returns The unique detected languages (empty when nothing matches).
 */
export function detectLanguages(
  files: string[],
  extensionMap?: Record<string, SupportedLanguage>,
): SupportedLanguage[] {
  const map = extensionMap ?? EXTENSION_TO_LANGUAGE;
  const normalized: Record<string, SupportedLanguage> = {};
  for (const [ext, lang] of Object.entries(map)) {
    normalized[ext.toLowerCase()] = lang;
  }

  const detected: SupportedLanguage[] = [];
  const seen = new Set<SupportedLanguage>();
  for (const file of files) {
    if (!file) continue;
    const lower = file.toLowerCase();
    const ext = '.' + lower.slice(lower.lastIndexOf('.') + 1);
    const language = normalized[ext];
    if (language && !seen.has(language)) {
      seen.add(language);
      detected.push(language);
    }
  }
  return detected;
}

/**
 * Build the language-specific prompt sections for the given languages.
 * Unknown languages are silently ignored; an empty array is returned when
 * no language has a registered module.
 *
 * @param languages - Detected languages to build guidance for.
 * @returns Array of markdown section strings (without leading newline).
 */
export function getLanguagePrompts(languages: SupportedLanguage[]): string[] {
  const sections: string[] = [];
  for (const language of languages) {
    const module = LANGUAGE_MODULES[language];
    if (module) {
      sections.push(module.prompt);
    }
  }
  return sections;
}
