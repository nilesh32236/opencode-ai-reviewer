import * as exec from '@actions/exec';
import { describe, expect, it, vi } from 'vitest';
import { ensureLocalBranchForPush } from '../src/fix';

vi.mock('@actions/exec', () => ({
  exec: vi.fn(),
  getExecOutput: vi.fn(),
}));

// Regression coverage for issue #674: the review-loop workflow checks out the
// pinned head SHA (detached HEAD, no local branch), so a bare
// `git push origin <headRef>` failed with "src refspec … does not match any"
// before any authentication happened (not a PAT problem). The helper must
// attach HEAD to the ref first, and must reject hostile ref names before
// interpolating them into git arguments.
describe('ensureLocalBranchForPush', () => {
  it('attaches HEAD to the head ref without touching the working tree', async () => {
    const mocked = vi.mocked(exec.exec).mockResolvedValue(0);
    mocked.mockClear();

    await ensureLocalBranchForPush('autofix/issue-664');

    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked).toHaveBeenCalledWith('git', ['checkout', '-B', 'autofix/issue-664']);
  });

  it('rejects hostile ref names before any git invocation', async () => {
    const mocked = vi.mocked(exec.exec).mockResolvedValue(0);
    mocked.mockClear();

    await expect(ensureLocalBranchForPush('--upload-pack=touch pwned')).rejects.toThrow();
    expect(mocked).not.toHaveBeenCalled();
  });
});
