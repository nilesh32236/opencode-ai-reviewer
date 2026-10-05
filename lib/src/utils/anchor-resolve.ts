/**
 * Publication-time resolution of finding anchors against a commit.
 *
 * A finding is a claim about a specific line of a specific file at a specific
 * revision. Nothing in the pipeline currently ties the three together, so a
 * line number survives into the published comment even when it points at
 * unrelated code — which is not a cosmetic problem. On the previous head all
 * four P1 anchors were wrong against the reviewed tree (+111, +139, +139 and
 * 0 lines), and the review's own body and its verification log disagreed by 135
 * lines about the location of the same function. A reviewer who follows a
 * stale anchor concludes the tool cannot count lines, and then stops reading
 * the findings that were right.
 *
 * Resolution here is deliberately narrow, because the honest version of this
 * check is the one that can only report what it actually verified:
 *
 *   - the file exists at the reviewed sha
 *   - the line is within that file at that sha
 *   - if the producing pass captured the source line, that text still matches
 *
 * The third check is what catches a file that shifted: a bare bounds check
 * passes happily on a line number that now points at a different statement.
 * Where the producing pass could not cheaply capture the text (model-reported
 * findings, for instance), `anchorText` is absent and resolution degrades to
 * existence-and-range — and {@link ReviewTrust.anchorsChecked} counts only
 * anchors genuinely verified, so an unverified anchor never inflates the
 * number of anchors that were checked.
 *
 * A finding that fails any check is marked `'stale-anchor'` and carries a note.
 * It is not dropped: a real defect reported against a moved line is still
 * worth seeing, it just has to be labelled as evidence about a past revision.
 */

/** Outcome of resolving one anchor. */
export type AnchorStatus = 'ok' | 'stale-anchor';

/** Reads file content at a commit. Returns undefined when unavailable. */
export type AnchorReader = (file: string, sha: string) => Promise<string | undefined>;

/** Input to {@link resolveAnchor}. */
export interface AnchorSubject {
  /** Repo-relative file path of the finding. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** Source line captured at finding time, when the pass had it cheaply. */
  anchorText?: string;
}

/** Result of {@link resolveAnchor}. */
export interface AnchorResolution {
  status: AnchorStatus;
  /** Present when status is `'stale-anchor'`. */
  note?: string;
  /** True when the source line was actually compared, not just bounded. */
  textVerified: boolean;
}

/**
 * Compare two source lines ignoring insignificant whitespace.
 *
 * Deliberately shallow. The goal is to notice that the line moved or was
 * rewritten, not to prove the finding still applies — an anchor that survives
 * this check is *plausible*, and the finding still has to be judged on its
 * merits. Treating "anchor resolved" as "finding is correct" would be the same
 * overclaim in a new place.
 * @param a - The first string to compare.
 * @param b - The second string to compare.
 * @returns True if the strings match after normalizing whitespace, false otherwise.
 */
function sameSourceLine(a: string, b: string): boolean {
  return a.trim().replace(/\s+/g, ' ') === b.trim().replace(/\s+/g, ' ');
}

/**
 * Resolve one finding's anchor against the reviewed commit.
 *
 * Never throws: an unreadable file is an unresolved anchor, not a crashed
 * review. An exception here would take down publication, which is the one
 * moment where losing the verdict is most expensive.
 *
 * @param subject - The finding's file, line and captured source line.
 * @param sha - Commit the anchors are being resolved against.
 * @param readFileAt - Reader for file content at that commit.
 * @returns The resolution, including whether the source text was verified.
 */
export async function resolveAnchor(
  subject: AnchorSubject,
  sha: string,
  readFileAt: AnchorReader,
): Promise<AnchorResolution> {
  if (!subject.file || subject.file.trim() === '') {
    return { status: 'stale-anchor', note: 'finding carries no file path', textVerified: false };
  }
  if (!Number.isInteger(subject.line) || subject.line < 1) {
    return {
      status: 'stale-anchor',
      note: `line ${subject.line} is not a valid 1-based line number`,
      textVerified: false,
    };
  }

  let content: string | undefined;
  try {
    content = await readFileAt(subject.file, sha);
  } catch {
    content = undefined;
  }
  if (content === undefined) {
    return {
      status: 'stale-anchor',
      note: `${subject.file} is not available at ${sha.slice(0, 7)}`,
      textVerified: false,
    };
  }

  const lines = content.split('\n');
  if (subject.line > lines.length) {
    return {
      status: 'stale-anchor',
      note: `line ${subject.line} is past the end of ${subject.file} at ${sha.slice(0, 7)} (${lines.length} lines)`,
      textVerified: false,
    };
  }

  if (subject.anchorText === undefined) {
    // Existence and range only. Reported honestly as unverified text rather
    // than as a passed check.
    return { status: 'ok', textVerified: false };
  }

  const actual = lines[subject.line - 1] ?? '';
  if (!sameSourceLine(actual, subject.anchorText)) {
    return {
      status: 'stale-anchor',
      note: `line ${subject.line} of ${subject.file} no longer holds the source line this finding was computed against`,
      textVerified: true,
    };
  }
  return { status: 'ok', textVerified: true };
}

/**
 * Resolve every anchor on a result in place, stamping status and note.
 *
 * Findings whose anchor cannot be checked because the reader could not supply
 * the file are counted as unresolved rather than silently passed — an anchor
 * nobody could verify is not evidence about this revision.
 *
 * @param issues - Findings to resolve; mutated in place.
 * @param sha - Commit the findings were computed against.
 * @param readFileAt - Reader for file content at that commit.
 * @returns Counts of anchors text-verified, range-verified only, and stale.
 */
export async function resolveIssueAnchors<
  T extends {
    file?: string;
    line?: number;
    anchorText?: string;
    anchorStatus?: 'ok' | 'stale-anchor';
    anchorNote?: string;
  },
>(
  issues: T[],
  sha: string,
  readFileAt: AnchorReader,
): Promise<{ checked: number; rangeChecked: number; stale: number }> {
  let checked = 0;
  let rangeChecked = 0;
  let stale = 0;

  for (const issue of issues) {
    const resolution = await resolveAnchor(
      {
        file: issue.file ?? '',
        line: issue.line ?? 0,
        ...(issue.anchorText !== undefined ? { anchorText: issue.anchorText } : {}),
      },
      sha,
      readFileAt,
    );
    if (resolution.status === 'stale-anchor') {
      stale++;
      issue.anchorStatus = 'stale-anchor';
      if (resolution.note) issue.anchorNote = resolution.note;
    } else {
      // Split by how the anchor was actually confirmed. `checked` counts only
      // anchors whose source line was compared; `rangeChecked` counts those
      // confirmed to exist and be in range only. Reporting a single merged
      // number would be the false-green this module exists to remove, because
      // a range-only anchor is exactly the kind that silently points at the
      // wrong code after a file shifts.
      if (resolution.textVerified) checked++;
      else rangeChecked++;
      issue.anchorStatus = 'ok';
    }
  }
  return { checked, rangeChecked, stale };
}
