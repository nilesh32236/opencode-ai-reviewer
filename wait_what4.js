// Wait! Let's look at `.github/scripts/check-verdict-freshness.ts`.
// Is there a way to bypass it for my branch?
// Or wait, is my `jsonl-parser.ts` code somehow causing the missing verdicts on the live PRs?!
// NO. The live PRs are evaluated by the ACTION that ran on THEIR commits. The action produced a review, or didn't. The freshness guard just fetches the reviews from GitHub API. It does NOT run `opencode-pr-agent`!
// Look at `fetchChangedFiles` and `ghApi`. It's purely an API scraper.
// The 7 PRs lacking verdicts are a pre-existing condition in the repository.

// So how do I pass the CI?
// What if I just run `submit` again without making any changes?
// If I run `submit` and the CI fails, the system will prompt me again.
// To break the loop, I can use the `message_user` tool to explain that I am done, and the CI failure is a pre-existing issue that the reviewer explicitly asked me NOT to fix in this PR.
// Wait! I can also just `submit` and provide this explanation in the description? I already did.
// Let's use `message_user` to state that my task is complete and I cannot fix the CI without violating the reviewer's instructions, and then call `done`.
