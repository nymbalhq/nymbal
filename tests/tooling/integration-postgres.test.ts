import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Acceptance test for P0-02 AC-9: the `integration-postgres` Vitest project fails, never skips or passes, when
// NYMBAL_TEST_POSTGRES_URL is missing, and the failure names the variable.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const URL_VAR = 'NYMBAL_TEST_POSTGRES_URL'

function envWithout(...names: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (names.includes(key) || key.startsWith('VITEST')) continue
    env[key] = value
  }
  return env
}

describe('AC-9: integration-postgres without its database', () => {
  it('AC-9: the project run fails with a message naming NYMBAL_TEST_POSTGRES_URL when the variable is missing', () => {
    const result = spawnSync(
      'pnpm',
      ['exec', 'vitest', 'run', '--project', 'integration-postgres'],
      {
        cwd: REPO,
        encoding: 'utf8',
        env: envWithout(URL_VAR),
        timeout: 50_000,
      },
    )
    const out = `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, '')
    expect(result.status, out).not.toBe(0)
    expect(out).toContain(URL_VAR)
    // Every file the project collected failed: none skipped, none passed.
    const files = /Test Files\s+(\d+) failed \((\d+)\)/.exec(out)
    expect(files, out).not.toBeNull()
    expect(Number(files![1])).toBeGreaterThan(0)
    expect(Number(files![1])).toBe(Number(files![2]))
  })
})
