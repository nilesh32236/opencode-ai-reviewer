/**
 * Shared heuristic to determine if a suggestion string looks like code rather
 * than a natural language description.
 */

// Declaration keywords that strongly indicate code when combined with other
// code-like patterns. Uses a word boundary (not whitespace) so standalone
// statements such as `return;` match without forcing trailing whitespace.
const STRONG_KEYWORD_PATTERN =
  /^(const|let|var|import|export|return|if|else|for|while|async|await|function|class|interface|type|enum)\b/;

// Weak code indicators that can also appear in natural language.
const WEAK_CODE_PATTERNS = [
  /[{};()=]/, // Syntax characters
  /^\s*\/\//, // Comments
  /\.\w+\(/, // Method calls
  /=>\s*/, // Arrow functions
  /\?\.\w+/, // Optional chaining
  /\?\?\s/, // Nullish coalescing
];

/**
 * Heuristic to determine if a suggestion string looks like code rather than
 * a natural language description. A suggestion is treated as code only when
 * at least two code patterns match. A single match — even a strong
 * declaration keyword — is insufficient: keywords like `if`, `return`,
 * `type`, and `class` are also common English words, and a lone keyword
 * cannot distinguish a real declaration from prose such as
 * "if you have any questions, please ask" or "return the result to the
 * caller." Genuine declarations (`const x = 1;`, `function foo() {}`,
 * `return;`) also match a weak symbol pattern (`=`, `;`, `(`, `{`), so
 * they still classify as code under the >=2 rule.
 * @param suggestion - The suggestion string to evaluate.
 * @returns True if the suggestion contains enough code-like patterns.
 */
export function looksLikeCode(suggestion: string): boolean {
  let matchCount = 0;
  if (STRONG_KEYWORD_PATTERN.test(suggestion)) matchCount++;
  for (const pattern of WEAK_CODE_PATTERNS) {
    if (pattern.test(suggestion)) matchCount++;
  }
  return matchCount >= 2;
}
