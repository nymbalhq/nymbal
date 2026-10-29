import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workspacePackageDirs } from '../../scripts/workspace-packages'
import { REPO_ROOT } from './workspace-manifests'

/** A file that calls one of the published suites. */
export const CALLS_A_SUITE = /\brun[A-Z]\w*Contract\s*\(/

/**
 * The contract runners: tests/contracts/*.test.ts, and `<member>/src/contract.test.ts` for each workspace member under
 * packages/ (at any depth), that call a suite.
 */
export function namedRunners(root: string = REPO_ROOT): string[] {
  const contracts = readdirSync(join(root, 'tests', 'contracts'))
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => `tests/contracts/${f}`)
  const packages = workspacePackageDirs(root)
    .filter((dir) => dir.startsWith('packages/'))
    .map((dir) => `${dir}/src/contract.test.ts`)
    .filter((f) => existsSync(join(root, f)))
  return [...contracts, ...packages].filter((f) =>
    CALLS_A_SUITE.test(readFileSync(join(root, f), 'utf8')),
  )
}
