# Release-note fragments

Every pull request adds one fragment: `release-notes/<slug>.md`.

- Write 1 to 5 short, user-facing lines. Each line becomes one bullet in the release text.
- For a change users cannot see (refactoring, CI, tests), use the single line `none`.
- Do not edit existing fragments; they are collected per release from the commits that added them.

The pull-request build fails when a branch adds no valid fragment.

Fragments are collected as first merged: edits after merge are ignored, and a
fragment deleted again before the release is not published. Text is escaped
(no HTML, no live `@mentions`, no leading Markdown) and each line is cut at 200
characters.
