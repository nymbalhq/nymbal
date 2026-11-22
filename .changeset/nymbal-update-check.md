---
'nymbal': minor
'create-nymbal-app': minor
'@nymbalhq/config': minor
---

New stores get `renovate.json` (one pull request per Nymbal release) and a workflow job running `nymbal update-check`, which lets a security update merge itself only under the `renovate/auto-updates` preset and when it adds no migration and the compatibility matrix certifies it. Breaking: `features.autoUpdates` is removed from the config; delete it from `nymbal.config.ts`.
