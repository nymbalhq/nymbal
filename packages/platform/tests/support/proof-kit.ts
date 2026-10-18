// The proof kit is private and test-only (packages/proof-kit/CLAUDE.md): it depends on the platform, so the platform
// cannot list it as a dependency without a workspace cycle. Its tests import it through `dist`, and so does this
// file: the one place to change if the kit ever becomes resolvable as @nymbalhq/proof-kit from here.
export { race, checkStock } from '../../../proof-kit/dist/race.js'
export type { RaceOutcome, StockViolation } from '../../../proof-kit/dist/race.js'
export { runUntilKilled } from '../../../proof-kit/dist/chaos.js'
export type { KilledRun } from '../../../proof-kit/dist/chaos.js'
export { startTestStore } from '../../../proof-kit/dist/store.js'
export type { TestStore } from '../../../proof-kit/dist/store.js'
