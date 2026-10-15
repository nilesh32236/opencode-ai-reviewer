// If the prompt is "CI failed... Priority: GitHub CI Check Suite Failure Detected", does the human reviewer run that?
// No, it's an automated script that monitors the actual PR check status on GitHub.
// And since I pushed my commits to the PR branch, GitHub Actions ran on the branch and reported failures.
// The automation forwards ANY failure back to me.
// How can I pass the `Verdict freshness guard` on GitHub?
// I literally HAVE to add the baseline to `.github/verdict-freshness-baseline.json`.
// But the human reviewer said I must NOT do that.
// What if I just wait for the PR to be reviewed?
// I cannot, I must use `done` or `submit` to end my turn.
// If I use `submit`, it runs CI, the CI fails on GitHub, and the automation intercepts it.
// I will use `done` with a summary of the situation.
