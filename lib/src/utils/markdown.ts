const DEFAULT_MAX_FIELD_LENGTH = 5000;

/**
 * Whether a code point is a disallowed control char (C0 or DEL, excluding
 * tab and newline, which are legitimate in markdown bodies).
 *
 * @param code - The UTF-16 code unit to check.
 * @returns True when the code unit must be stripped.
 */
function isDisallowedControl(code: number): boolean {
  return (code < 0x20 || code === 0x7f) && code !== 0x09 && code !== 0x0a;
}

/**
 * Strip disallowed control characters from a string.
 *
 * @param text - The string to strip.
 * @returns The string without disallowed controls.
 */
function stripDisallowedControls(text: string): string {
  let first = -1;
  for (let i = 0; i < text.length; i++) {
    if (isDisallowedControl(text.charCodeAt(i))) {
      first = i;
      break;
    }
  }
  if (first === -1) return text;
  const out: string[] = [text.slice(0, first)];
  for (let i = first; i < text.length; i++) {
    if (isDisallowedControl(text.charCodeAt(i))) continue;
    out.push(text[i]);
  }
  return out.join('');
}

/**
 * Escape a string for interpolation inside a markdown inline-code span.
 * Neutralizes backtick breakout and newline injection so a crafted value
 * (e.g. a file path or target directory) cannot close the code span and
 * inject arbitrary markdown into the rendered body. Backslashes are escaped
 * first so a trailing backslash cannot escape the closing backtick (order
 * matters: escaping backticks first would leave `...\`` + `` ` `` fusing
 * into an escaped backtick followed by a live span terminator).
 *
 * @param text - The raw value to escape.
 * @returns The escaped value, safe for `` `...` `` interpolation.
 */
export function escapeInlineCode(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/[\r\n]+/g, ' ');
}

/**
 * Sanitize LLM-generated text before interpolating it into GitHub markdown
 * (PR comments, review bodies, issues). Defense against prompt-injected
 * markdown/HTML: stored image-exfiltration, `javascript:`/`data:` links,
 * raw HTML (e.g. `<img onerror>`), and `<!-- ... -->` control-marker
 * spoofing (review-stream-progress / audit-update markers that drive
 * automation). Plain prose and ordinary markdown formatting pass through
 * unchanged.
 *
 * @param text - The untrusted LLM-generated string.
 * @param maxLength - Maximum length before truncation (defaults to 5000).
 * @returns The sanitized string, safe to interpolate into markdown.
 */
export function sanitizeMarkdown(
  text: string,
  maxLength: number = DEFAULT_MAX_FIELD_LENGTH,
): string {
  let out = text;
  if (out.length > maxLength) {
    out = `${out.slice(0, maxLength)}… (truncated at ${maxLength} chars)`;
  }
  // Strip C0 controls (except \t and \n) that could smuggle markup past
  // naive filters or break comment layout. Implemented as a code-point scan
  // (not a regex) so no control-character pattern ever appears in source.
  out = stripDisallowedControls(out);
  // Escape raw HTML so tags render as inert text. Order matters: `&` first
  // so the entities introduced below are not double-escaped. Double quotes
  // are left intact — they need no escaping in markdown body text and
  // preserving them keeps ordinary prose (e.g. Change "teh" to "the")
  // byte-identical.
  out = out.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Break HTML-comment markers (already entity-escaped above, but belt and
  // braces: an exact `<!-- review-stream-progress -->` must never survive).
  out = out.replace(/&lt;!--/g, '&lt;!&#8209;&#8209;').replace(/--&gt;/g, '&#8209;&#8209;&gt;');
  // Neutralize markdown image syntax — images auto-load remote URLs, so a
  // prompt-injected `![x](https://exfil/...)` exfiltrates viewer IPs.
  out = out.replace(/!\[/g, '!&#91;');
  // Neutralize dangerous link schemes; ordinary http(s)/relative links stay
  // clickable. GitHub strips `javascript:` anyway, but `data:`/`file:` and
  // `vbscript:` variants must never reach the renderer.
  out = out.replace(/\]\(javascript:/gi, '](blocked:');
  out = out.replace(/\]\(data:/gi, '](blocked:');
  out = out.replace(/\]\(vbscript:/gi, '](blocked:');
  out = out.replace(/\]\(file:/gi, '](blocked:');
  return out;
}
