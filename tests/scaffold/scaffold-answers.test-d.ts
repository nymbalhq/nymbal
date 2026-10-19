import type { scaffold } from '../../packages/create-app/src/index.js'

// P1-07 AC-1 (type half): the answers scaffold() takes have no `includeMobile`. Checked by the root typecheck
// (`tsc -b` includes tests/**/*.ts); the prompt half is in packages/create-app/test/clean-machine.test.ts.
type ScaffoldAnswers = Parameters<typeof scaffold>[1]
type HasIncludeMobile = 'includeMobile' extends keyof ScaffoldAnswers ? true : false

export const ac1ScaffoldAnswersHaveNoIncludeMobile: HasIncludeMobile = false
