# @nymbalhq/search-algolia

## 1.5.1

### Patch Changes

- 853d563: Every package has a README on npm. `nymbal mcp` now passes on the name and version of the MCP host that connected, so proposals, carts and orders record that agent rather than a generic client.
  `create-nymbal-app` ends by naming where to report a problem.

## 1.5.0

### Minor Changes

- bb453b8: New `algolia` search provider (`@nymbalhq/search-algolia`, `nymbal add algolia`), matching as native search does. Fill
  it once with `nymbal replay --to search`. A restart no longer rebuilds a search index that lives in a package.
