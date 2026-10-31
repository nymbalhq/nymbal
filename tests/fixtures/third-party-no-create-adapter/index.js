// A package with an adapter-ish export under another name and no `createAdapter`, which
// `nymbal test:contracts --package` must refuse in one line rather than crash on.

export const slot = 'search'
export const provider = 'acme'

export function createSearchAdapter() {
  return { kind: 'search', providerName: 'acme-no-factory' }
}
