import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

// Acceptance test for P1-09 AC-9 (the Playwright half): Astro 7 backgrounds `astro dev` when it detects an AI agent,
// so Playwright's webServer sees its child exit. The astro webServer command passes --ignore-lock to astro, and the
// Next one does not (next dev rejects an unknown option). The config is evaluated in a child process with the
// environment the gate's E2E step gives it (CI=1, NYMBAL_E2E_TARGET), as playwright-target.test.ts does.

const exec = promisify(execFile)

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')
const E2E_DIR = join(REPO, 'tests/e2e')
const CONFIG_URL = pathToFileURL(join(E2E_DIR, 'playwright.config.ts')).href

const PRINT_WEB_SERVERS = `import(process.env.NYMBAL_TEST_CONFIG_URL).then((m) => {
  process.stdout.write('\\n' + JSON.stringify(m.default.webServer ?? null) + '\\n')
})`

const CONFIG_ENV = [
  'CI',
  'NYMBAL_E2E_TARGET',
  'NYMBAL_E2E_ADMIN',
  'NYMBAL_STOREFRONT_URL',
  'NYMBAL_ADMIN_URL',
]

async function storefrontCommand(target: 'astro' | 'nextjs'): Promise<string> {
  const base: NodeJS.ProcessEnv = { ...process.env }
  for (const key of CONFIG_ENV) delete base[key]
  const { stdout } = await exec(TSX, ['--eval', PRINT_WEB_SERVERS], {
    cwd: E2E_DIR,
    env: { ...base, CI: '1', NYMBAL_E2E_TARGET: target, NYMBAL_TEST_CONFIG_URL: CONFIG_URL },
  })
  const servers = JSON.parse(stdout.trimEnd().split('\n').pop() ?? '[]') as Array<{
    command: string
  }>
  const storefront = servers.filter((s) => !/--api-only/.test(s.command))
  expect(storefront, JSON.stringify(servers)).toHaveLength(1)
  return storefront[0]!.command
}

describe('AC-9: the Playwright astro webServer keeps astro dev in the foreground under an agent', () => {
  it('AC-9: with CI=1 and NYMBAL_E2E_TARGET=astro, the astro command passes --ignore-lock after dev; the nextjs command does not', async () => {
    const astro = (await storefrontCommand('astro')).split(/\s+/)
    const nextjs = (await storefrontCommand('nextjs')).split(/\s+/)

    expect(astro, astro.join(' ')).toContain('--ignore-lock')
    expect(astro.indexOf('--ignore-lock')).toBeGreaterThan(astro.indexOf('dev'))
    expect(nextjs, nextjs.join(' ')).not.toContain('--ignore-lock')
  }, 30_000)
})
