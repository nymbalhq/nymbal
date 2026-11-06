# UCP schemas, vendored

`2026-08-25/` is the `source/schemas/` tree of the Universal Commerce Protocol at tag `v2026-08-25` (tag object
`1c225995e9db9808c23fc6440fc70f38b27d914a`), unchanged: 121 JSON Schema files (draft 2020-12), 251 900 bytes.

- Source: https://github.com/Universal-Commerce-Protocol/ucp/tree/v2026-08-25/source/schemas
- Published at: https://ucp.dev/2026-08-25/schemas/
- Licence: Apache License 2.0, copied beside the schemas as `2026-08-25/LICENSE`.

`validate.ts` loads every file by its `$id` (`https://ucp.dev/schemas/...`) into Ajv 2020 with `ajv-formats` and
never reaches the network. `validateUcp('profile.json#/$defs/business_schema', value)` answers the validation errors,
none when the value conforms.

To move to another UCP release, add its tree beside this one under the release's date; do not edit these files.
