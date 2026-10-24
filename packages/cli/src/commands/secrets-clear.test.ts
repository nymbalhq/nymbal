import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  attemptStore,
  cleanups,
  newSecretsKey,
  saveSettings,
  SECRETS_KEY,
  setEnv,
  settingsConfig,
  settingsConfigInput,
  storedSettings,
  openReader,
} from '../../../platform/tests/support/settings.js'
import { cliEnv, runCli } from '../../../../tests/support/doctor.js'

// AC-6, recovery from a lost key: `nymbal secrets clear [--slot <s>] [--path <p>]` with NYMBAL_SECRETS_KEY unset
// deletes the matching rows (a filtered clear that row alone), and the store then boots without the key.
// Spawns the built CLI (`pnpm build` first).

const COMMERCE = {
  ai: { provider: 'anthropic' },
  email: { provider: 'smtp', config: { smtp: { host: '127.0.0.1', port: 2525 } } },
}

const scope = cleanups()
afterEach(() => scope.run())

describe('AC-6: nymbal secrets clear needs no key', () => {
  it('AC-6: with NYMBAL_SECRETS_KEY unset, clear --slot --path removes one row, clear removes the rest, and the store then boots without a key', async () => {
    scope.add(
      setEnv({
        [SECRETS_KEY]: newSecretsKey(),
        ANTHROPIC_API_KEY: undefined,
      }),
    )
    const dir = mkdtempSync(join(tmpdir(), 'settings-clear-'))
    scope.add(() => rmSync(dir, { recursive: true, force: true }))
    writeFileSync(
      join(dir, 'nymbal.config.ts'),
      `export default ${JSON.stringify(settingsConfigInput('sqlite', COMMERCE), null, 2)}\n`,
    )
    const db = join(dir, 'nymbal.db')
    const config = settingsConfig('sqlite', COMMERCE)
    await saveSettings({ dialect: 'sqlite', target: db, config }, [
      ['ai', 'apiKey', `sk-ant-settings-clear-${Date.now()}`],
      ['email', 'smtp.pass', `smtp-pass-settings-clear-${Date.now()}`],
    ])
    scope.add(setEnv({ [SECRETS_KEY]: undefined }))
    const refused = await attemptStore({ dialect: 'sqlite', target: db, config })
    if (refused.store !== undefined) scope.add(() => refused.store.stop())
    expect(refused.error, 'a secret row with no key refuses boot').toBeDefined()

    const raw = openReader('sqlite', db)
    scope.add(() => raw.close())
    const env = cliEnv({ NYMBAL_SQLITE_PATH: db, [SECRETS_KEY]: undefined })
    const before = await storedSettings(raw)

    const one = await runCli(['secrets', 'clear', '--slot', 'ai', '--path', 'apiKey'], {
      cwd: dir,
      env,
    })
    expect(one.code, one.out).toBe(0)
    const afterOne = await storedSettings(raw)
    expect(afterOne.length).toBe(before.length - 1)
    expect(afterOne.map((r) => `${r.slot}.${r.path}`)).toEqual(['email.smtp.pass'])

    const rest = await runCli(['secrets', 'clear'], { cwd: dir, env })
    expect(rest.code, rest.out).toBe(0)
    expect(await storedSettings(raw)).toEqual([])

    const booted = await attemptStore({ dialect: 'sqlite', target: db, config })
    if (booted.store !== undefined) scope.add(() => booted.store.stop())
    expect(booted.error).toBeUndefined()
  }, 120_000)
})
