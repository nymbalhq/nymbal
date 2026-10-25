import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

// Each E2E target is its own Playwright invocation, bounded as a whole: a hung run (the admin project once ran 389 s
// against a 9.5 s median) goes red at the bound. The config is evaluated in a child process with the environment a
// run would have, so the bound is read exactly as Playwright reads it.

const exec = promisify(execFile)

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')
const E2E_DIR = join(REPO, 'tests/e2e')
const CONFIG_URL = pathToFileURL(join(E2E_DIR, 'playwright.config.ts')).href

const PRINT = `import(process.env.NYMBAL_TEST_CONFIG_URL).then((m) => {
  process.stdout.write('\\n' + JSON.stringify(m.default.globalTimeout ?? null) + '\\n')
})`

const CONFIG_ENV = ['CI', 'GITHUB_ACTIONS', 'NYMBAL_E2E_GLOBAL_TIMEOUT_MS', 'NYMBAL_E2E_TARGET']

async function globalTimeout(env: Record<string, string>): Promise<number | null> {
  const base: NodeJS.ProcessEnv = { ...process.env }
  for (const key of CONFIG_ENV) delete base[key]
  const { stdout } = await exec(TSX, ['--eval', PRINT], {
    cwd: E2E_DIR,
    env: { ...base, ...env, NYMBAL_TEST_CONFIG_URL: CONFIG_URL },
  })
  return JSON.parse(stdout.trimEnd().split('\n').pop() ?? 'null') as number | null
}

describe('the E2E run is bounded as a whole', () => {
  it('five minutes under CI=1 locally (the gate), ten on GitHub, unbounded by hand', async () => {
    expect(await globalTimeout({ CI: '1', NYMBAL_E2E_TARGET: 'admin' })).toBe(5 * 60_000)
    expect(
      await globalTimeout({ CI: '1', GITHUB_ACTIONS: 'true', NYMBAL_E2E_TARGET: 'admin' }),
    ).toBe(10 * 60_000)
    expect(await globalTimeout({})).toBe(0)
  })

  it('NYMBAL_E2E_GLOBAL_TIMEOUT_MS overrides the bound', async () => {
    expect(await globalTimeout({ CI: '1', NYMBAL_E2E_GLOBAL_TIMEOUT_MS: '90000' })).toBe(90_000)
  })
})
