---
'nymbal': patch
---

`nymbal add` checks the edited config with every `.env` value applied, as `nymbal dev` loads them, so a bad value read through `envNumber()` or `process.env` is caught before the config is written.
