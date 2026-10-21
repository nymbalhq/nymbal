// P2-13 AC-6 (spec P2-13-contract-tests-public): a package with an adapter-ish export under another name and no
// `createAdapter`, which `nymbal test:contracts --package` must refuse in one line rather than crash on.

export function createSearchAdapter() {
  return { kind: 'search', providerName: 'acme-no-factory' }
}
