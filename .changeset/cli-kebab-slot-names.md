---
'nymbal': minor
'@nymbalhq/platform': minor
---

Commands print slots in kebab case (`document-store`, `event-bus`): doctor's checks, `nymbal dev` and `config:validate`; `test:contracts --slot` accepts either spelling.
Breaking: a script reading `nymbal doctor --json` matches `primitive document-store` and `primitive event-bus` (and the same for `package`) now, in place of the camelCase names; `config:validate`'s summary says `command store:` in place of `commandStore:`.
