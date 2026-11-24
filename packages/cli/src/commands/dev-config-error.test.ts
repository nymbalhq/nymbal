import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ADAPTER_CATALOGUE, conventionPackage } from '@nymbalhq/config'
import { installLine } from '@nymbalhq/platform'
import { cliEnv, freePort, runCli, stripAnsi } from '../../../../tests/support/doctor.js'
import { workspace } from '../../../../tests/support/project.js'
import { storeConfig, storeProject } from '../../../../tests/support/start.js'

// AC-7: `nymbal dev` prints a config mistake as `<message> [<code>]` on one stderr line and exits 1: the code of an
// adapter refusal, and `config.invalid` for a ConfigError that names none. Spawns the built CLI (`pnpm build` first)
// in a store project of its own, on a fresh SQLite file and a free port.

let cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup.reverse()) fn()
  cleanup = []
})

/** `nymbal dev --api-only` in a project whose commerce config is `commerce` over the native defaults. */
async function devWith(
  commerce: Record<string, unknown>,
  installed: Record<string, string> = {},
  extraEnv: Record<string, string> = {},
) {
  const base = storeConfig()
  const project = storeProject(
    { ...base, commerce: { ...(base['commerce'] as Record<string, unknown>), ...commerce } },
    installed,
  )
  cleanup.push(() => project.remove())
  const env = cliEnv({ NYMBAL_SQLITE_PATH: join(project.dir, 'nymbal.db'), ...extraEnv })
  const run = await runCli(['dev', '--api-only', '--port', String(await freePort())], {
    cwd: project.dir,
    env,
    timeoutMs: 60_000,
  })
  return { run, env, dir: project.dir, lines: stripAnsi(run.stderr).split('\n') }
}

describe('AC-7: nymbal dev prints a config error with its code', () => {
  it('AC-7: commerce.email naming resend, whose package is not installed, exits 1 with one stderr line holding the install hint and ending [adapter.package_missing]', async () => {
    const pkg = conventionPackage('email', 'resend')
    const sdk = ADAPTER_CATALOGUE.email['resend']?.sdk
    expect(sdk, 'the catalogue names the resend SDK').toBe('nodemailer')

    const { run, env, dir, lines } = await devWith({ email: { provider: 'resend' } })
    const install = installLine([pkg, sdk!], env, dir)

    const hinted = lines.filter((l) => l.includes(install))
    expect(run.code, run.out).toBe(1)
    expect(hinted, run.out).toHaveLength(1)
    // The code follows the message on the same line, and on no other.
    expect(
      lines.filter((l) => l.endsWith(' [adapter.package_missing]')),
      run.out,
    ).toEqual(hinted)
  }, 90_000)

  it('AC-7: a ConfigError with no code of its own (commerce.ai on openai with no model) exits 1 with its message followed by [config.invalid]', async () => {
    const { run, lines } = await devWith(
      { ai: { provider: 'openai' } },
      workspace('@nymbalhq/ai-openai'),
      { OPENAI_API_KEY: 'sk-dev-config-error' },
    )

    const said = lines.filter((l) => l.startsWith('commerce.ai.config.model is not set'))
    expect(run.code, run.out).toBe(1)
    expect(said, run.out).toHaveLength(1)
    expect(
      lines.filter((l) => l.endsWith(' [config.invalid]')),
      run.out,
    ).toEqual(said)
  }, 90_000)
})
