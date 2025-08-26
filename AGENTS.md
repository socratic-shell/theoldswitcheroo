# mdbook reference material

* The mdbook found whose contents are in `md/SUMMARY.md` contains design documentation and other reference material.
* Read [the mdbook table of contents](md/SUMMARY.md) before embarking on implementation to remember the architecture. Read any relevant chapters in full.
* When making changes, always update the corresponding design docs, adding new documentation if needed.

# code authorship

* When generating code, use AI insight comment as [described here](./.socratic-shell/ai-insights.md).
* **Auto-commit completed work**: After completing a series of related changes, automatically commit them with a descriptive message. This makes it easier for the user to review progress.
* **Co-authorship**: Include "Co-authored-by: Claude <claude@anthropic.com>" in commit messages to indicate AI collaboration.

# checkpointing and github tracking issues

Track work using github tracking issues as [described here](./.socratic-shell/github-tracking-issues.md). Use the `gh` CLI to interact with github, it's the most reliable.

Create them on the `socratic-shell/theoldswitcheroo` repository.

When checkpointing:

* Check that there are no uncommitted changes in git.
    * If there are, ask the user how to proceed.
* Update tracking issue (if any)
* Check that mdbook is up-to-date if any user-impacting or design changes have been made
    * If mdbook is not up-to-date, ask user how to proceed
