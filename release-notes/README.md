# Release-note fragments

Every pull request adds one fragment: `release-notes/<slug>.md`.

- Write 1 to 5 short, user-facing lines. Each line becomes one bullet in the release text.
- For a change users cannot see (refactoring, CI, tests), use the single line `none`.
- Do not edit existing fragments; they are collected per release from the commits that added them.

The pull-request build fails when a branch adds no valid fragment.
