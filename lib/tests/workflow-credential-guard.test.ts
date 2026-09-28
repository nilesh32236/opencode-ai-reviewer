import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

/**
 * Issue #852: a job that runs `uses: ./` on a `pull_request` ref while holding a
 * PAT or provider API key executes PR-controlled code, because `uses: ./` loads
 * the action manifest from the checkout -- which on `pull_request` is
 * `refs/pull/N/merge` -- not from the default branch.
 *
 * These assertions are static on purpose. The property being defended is a
 * property of the workflow file, and a runtime test could not observe it: the
 * job either starts with a credential or it does not.
 */

const workflowPath = new URL('../../.github/workflows/ai-review.yml', import.meta.url);
const workflowSource = readFileSync(workflowPath, 'utf8');

interface WorkflowStep {
  uses?: string;
  with?: Record<string, string>;
}

interface WorkflowJob {
  if?: string;
  'runs-on'?: string;
  env?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface WorkflowFile {
  on?: Record<string, unknown> | string;
  jobs: Record<string, WorkflowJob>;
}

const workflow = load(workflowSource) as WorkflowFile;
const jobs = workflow.jobs;

const publisherSource = readFileSync(
  new URL('../../.github/workflows/self-improvement.yml', import.meta.url),
  'utf8',
);

/**
 * The branch prefix the autonomous publisher actually writes to, read from the
 * publisher itself rather than restated here. If `BRANCH="improvement/..."` is
 * renamed, this follows it and the guard assertion fails loudly — instead of
 * both the assertion and the workflow guard silently protecting a prefix nobody
 * publishes to any more.
 */
const publishedPrefix = /^\s*BRANCH="([a-z][a-z0-9-]*)\//m.exec(publisherSource)?.[1];

/** Every `secrets.*` reference appearing in a job's `if:`, `env:`, or its steps. */
function secretsInJob(job: WorkflowJob): string[] {
  // A job-level `env:` is legal in Actions and is the natural place to hoist
  // `github_token: ${{ secrets.GH_PAT }}` out of a step, so scan it too —
  // otherwise a hoisted secret would drop the job out of the exposed set.
  const body = `${job.if ?? ''}\n${JSON.stringify(job.env ?? {})}\n${JSON.stringify(job.steps ?? [])}`;
  return [...new Set([...body.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
}

/** Jobs that execute this repository's own action code. */
function jobsUsingLocalAction(): string[] {
  return Object.entries(jobs)
    .filter(([, job]) => (job.steps ?? []).some((step) => step.uses === './'))
    .map(([name]) => name)
    .sort();
}

/**
 * Events a job may be *positively* restricted to.
 *
 * Classification is deliberately fail-closed: a job counts as
 * pull_request-reachable unless its `if:` positively pins it to a non-PR event
 * AND never reads a pull-request payload. Matching on the *presence* of
 * `event_name == 'pull_request'` instead would drop a job that is reachable
 * through some other spelling — or through no `if:` at all — and the security
 * loop below would then pass vacuously over a smaller set than it claims.
 *
 * The payload check is what keeps this honest in both directions: `autofix`
 * names `issue_comment` but also serves `pull_request`, so it stays in the set,
 * while `fix-issue` only ever reads `github.event.issue.pull_request` (a URL
 * fragment on an *issue* event, not a PR payload) and is correctly excluded.
 */
const NON_PULL_REQUEST_EVENT =
  /github\.event_name\s*==\s*'(issues|issue_comment|workflow_dispatch|schedule|push)'/;
const READS_PULL_REQUEST_PAYLOAD = /github\.event\.pull_request\./;

function jobsReachableFromPullRequest(): string[] {
  return Object.entries(jobs)
    .filter(([, job]) => {
      const condition = job.if ?? '';
      if (READS_PULL_REQUEST_PAYLOAD.test(condition)) return true;
      return !NON_PULL_REQUEST_EVENT.test(condition);
    })
    .map(([name]) => name)
    .sort();
}

/** The subset that is actually exposed: pull_request-reachable AND holding secrets. */
function exposedJobs(): string[] {
  return jobsReachableFromPullRequest().filter((name) => {
    const job = jobs[name];
    const runsLocalAction = (job?.steps ?? []).some((step) => step.uses === './');
    return runsLocalAction && secretsInJob(job as WorkflowJob).length > 0;
  });
}

describe('ai-review.yml credential guards', () => {
  it('parses and finds the expected secret-bearing jobs', () => {
    // If this fails the guards below are vacuously passing.
    expect(jobsUsingLocalAction()).toEqual(['autofix', 'fast-review', 'fix-issue', 'review']);
    // `auto-merge` and `notify-merged` are pull_request-reachable but drive the gh
    // CLI rather than `uses: ./`, so they are not part of the exposed set.
    expect(exposedJobs()).toEqual(['autofix', 'review']);
  });

  it('no pull_request-reachable job runs `uses: ./` with a PAT or provider key unguarded', () => {
    for (const name of exposedJobs()) {
      const job = jobs[name];
      if (!job) throw new Error(`Unknown job: ${name}`);

      expect(
        job.if ?? '',
        `Job "${name}" runs \`uses: ./\` on a pull_request ref with ${secretsInJob(job).join(', ')} ` +
          'but has no `if:`, so a fork or agent-authored PR reaches it unguarded.',
      ).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    }
  });

  it('the review job carries both the same-repository guard and the publisher exclusion', () => {
    const condition = jobs.review?.if ?? '';
    expect(publishedPrefix, 'could not read BRANCH prefix from self-improvement.yml').toBeDefined();
    expect(condition).toContain(
      'github.event.pull_request.head.repo.full_name == github.repository',
    );
    // self-improvement.yml opens agent-authored PRs on same-repo branches, so
    // the same-repository guard alone does not close that chain. The prefix is
    // read from the publisher, not restated, so a rename breaks this assertion.
    expect(condition).toContain(
      `!startsWith(github.event.pull_request.head.ref, '${publishedPrefix}/')`,
    );
    // The pre-existing autofix/ exclusion must survive the change.
    expect(condition).toContain("!startsWith(github.event.pull_request.head.ref, 'autofix/')");
  });

  it('keeps the bot-actor exclusion, so bot-authored PRs stay unreviewed', () => {
    for (const actor of ['github-actions[bot]', 'opencode-ai-reviewer[bot]', 'dependabot[bot]']) {
      expect(jobs.review?.if ?? '').toContain(actor);
    }
  });

  it('keeps every review clause a real guard rather than a blanket disable', () => {
    // `toContain` alone cannot tell a guard from `if: false` with decoration:
    // both satisfy any substring check. So assert the SHAPE of every clause --
    // each must be a comparison or a negated call, never a bare boolean.
    const condition = jobs.review?.if ?? '';
    expect(condition.length).toBeGreaterThan(0);

    const clauses = condition
      .split('&&')
      .map((clause) => clause.trim())
      .filter(Boolean);

    expect(clauses.length).toBeGreaterThan(2);
    for (const clause of clauses) {
      const isComparison = /==|!=|<=|>=|<|>/.test(clause);
      const isNegatedCall = /^!\s*[a-zA-Z]/.test(clause);
      expect(
        isComparison || isNegatedCall,
        `Clause "${clause}" is neither a comparison nor a negated call -- ` +
          'a bare boolean here would silently disable the job.',
      ).toBe(true);
    }
  });

  it('the autofix job keeps its own same-repository guard (regression guard for #852)', () => {
    expect(jobs.autofix?.if ?? '').toContain(
      'github.event.pull_request.head.repo.full_name == github.repository',
    );
  });

  it('does not weaken the guard by re-adding a PAT fallback to a newly-guarded job', () => {
    // `secrets.GH_PAT || secrets.GITHUB_TOKEN` is safe only while a guard holds;
    // this asserts the guarded set did not silently shrink back to one job.
    const guarded = exposedJobs().filter((name) =>
      (jobs[name]?.if ?? '').includes('head.repo.full_name == github.repository'),
    );
    expect(guarded).toEqual(['autofix', 'review']);
  });
});
