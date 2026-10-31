// The third-party search adapter under another package name, whose `slot` export says it serves payments: a module
// `nymbal test:contracts` must refuse on the search slot, however well its adapter would pass the search suite.

export * from '../third-party-search/index.js'
export const slot = 'payments'
