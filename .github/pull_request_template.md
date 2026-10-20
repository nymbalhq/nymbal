**Task:** <!-- board id, e.g. P1-02; one task per pull request -->

<!-- What changes and why, in a few lines. -->

**Tests**

- Added: <!-- files, and the criterion or invariant each exists for -->
- Removed: <!-- files and why (cannot fail, presence only, duplicate); "none" is an answer -->
- Shown failing before the change: <!-- commit or run -->

<!-- A pull request that regenerates visual baselines has its reviewer open the changed mobile PNGs, since no job
compares them before merge. -->

**Changeset:** <!-- the changeset file, or "none: no published package changes" -->

**Store end states**

<!-- The spec's `## Store end states` lines as they stand: `- `<id>`: ships AC-n | holds | not-yet <task>`, or
`none: <reason>`. A fix/ branch with no spec: the end states its diff meets, or "none: <reason>". -->

**Store walk**

<!-- The qa agent's task-mode block, pasted as returned. merge-task.sh refuses it unless it has one line per feature
and probe that `ledger.mjs touched` prints, for each surface, all OK, at a `walked` sha no touched path changed after.
`none: <reason>` only when `touched` prints nothing. -->

walked <!-- sha -->

- [<!-- feature file or probe id --> · <!-- astro|nextjs|admin -->] OK <!-- (what was done, what was seen) -->

**Gate:** <!-- `pnpm gate:full` verdict line and time -->
