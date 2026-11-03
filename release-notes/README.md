# Release-note fragments

Every pull request adds one fragment: `release-notes/<slug>.md`.

- Write 1 to 5 short, user-facing lines. Each line becomes one bullet in the release text.
- For a change users cannot see (refactoring, CI, tests), use the single line `none`.
- A fragment belongs to the release whose range contains the commit that added it.

The pull-request build fails when a branch adds no valid fragment.

The text as of the release commit counts: edits made within the pull request, or
after merge but before the release, are published; a fragment deleted again before
the release is not published, and a fragment edited after its release is not
collected again. Text is escaped (no HTML, no live `@mentions`, no leading
Markdown) and each line is cut at 200 characters.
