import fc from 'fast-check'

// Stryker's runs only (each Stryker Vitest config lists this file in `setupFiles`). A property test draws new inputs on
// every run, so a mutant it kills on one run can survive the next and a mutation score moves with no code changed. A
// fixed seed makes each property draw the same inputs in every Stryker run; the gate and `pnpm test` stay random, so
// they keep finding new counterexamples.
export const STRYKER_FAST_CHECK_SEED = 20261105

fc.configureGlobal({ ...fc.readConfigureGlobal(), seed: STRYKER_FAST_CHECK_SEED })
