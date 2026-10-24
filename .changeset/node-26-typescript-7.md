---
'@nymbalhq/platform': patch
'create-nymbal-app': patch
---

Node 26 and TypeScript 7.

- **Platform.** `better-sqlite3` moves to `^12.11.1`, the first line with Node 26 binaries; 11.x does not build on
  Node 26. Node 22 and 24 keep working.
- **create-nymbal-app.** A new project pins Node `26.12.1` in `.node-version`. Its `typescript` is
  `@typescript/typescript6` (the 6.0 API that Next and `astro check` load), and the Next template adds
  `@typescript/native` (TypeScript 7.0) for its `tsc`, as the TypeScript 7.0 release recommends.
