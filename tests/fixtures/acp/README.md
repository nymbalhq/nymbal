# ACP schemas, vendored

`2026-04-17/` holds the Agentic Commerce Protocol's JSON Schemas and checkout examples for version `2026-04-17`, the
release the repository's README marks latest stable, at commit `7fdd78df677a94dce04c770644b0fbbb1401272b`
(2026-07-18), unchanged. The repository has no tags or releases; versions are dated folders.

- The seven bundles of `spec/2026-04-17/json-schema/` (draft 2020-12, no external `$ref`):
  `schema.{agentic_checkout,cart,delegate_authentication,delegate_payment,discount,extension,feed}.json`
- `examples/2026-04-17/examples.agentic_checkout.json`
- Source: https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/tree/7fdd78df677a94dce04c770644b0fbbb1401272b/spec/2026-04-17/json-schema
- Raw files: `https://raw.githubusercontent.com/agentic-commerce-protocol/agentic-commerce-protocol/7fdd78df677a94dce04c770644b0fbbb1401272b/spec/2026-04-17/json-schema/<file>`
  and `.../examples/2026-04-17/examples.agentic_checkout.json`
- Licence: Apache License 2.0, copied beside the schemas as `2026-04-17/LICENSE`, with the repository's `NOTICE`.

`validate.ts` loads each bundle under its own `$id` into Ajv 2020 with `ajv-formats` and never reaches the network.
`validateAcp('schema.agentic_checkout.json#/$defs/CheckoutSession', value)` answers the validation errors, none when
the value conforms. `acpExample(name)` answers one of the vendored examples.

To move to another ACP version, add its folder beside this one under the version's date; do not edit these files.
