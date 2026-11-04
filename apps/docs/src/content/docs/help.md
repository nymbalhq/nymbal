---
title: Getting help
description: Where to report a bug, ask a question, or report a vulnerability.
---

## A bug or a question

Open an issue at [github.com/nymbalhq/nymbal/issues](https://github.com/nymbalhq/nymbal/issues). The bug form asks
for what helps most:

```sh
npx nymbal --version
npx nymbal doctor --json
```

`nymbal doctor` changes nothing and prints no secrets: it checks your config, packages, database and each provider.
Say which template you use, your Node.js version (`node --version`), what you did, what you expected and what
happened.

## A vulnerability

Please do not open an issue. Report it privately from the repository's
[Security tab](https://github.com/nymbalhq/nymbal/security/advisories/new), as the
[security policy](https://github.com/nymbalhq/nymbal/blob/main/SECURITY.md) describes.

## Contributing

Fixes, adapters and docs are welcome: see
[CONTRIBUTING.md](https://github.com/nymbalhq/nymbal/blob/main/CONTRIBUTING.md).
