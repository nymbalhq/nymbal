import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nymbalConfigSchema } from '@nymbalhq/config'
import {
  saveSettings,
  setEnv,
  settingsConfig,
  settingsConfigInput,
} from '../../../platform/tests/support/settings.js'
import { runCli } from '../../../../tests/support/doctor.js'
import { workspace } from '../../../../tests/support/project.js'
import {
  secretsKey,
  startEnv,
  storeConfig,
  storeProject,
  upstream,
} from '../../../../tests/support/start.js'
import { checkStartEnv } from './start.js'

// AC-2: `nymbal start` with a problem in its environment, or a config that refuses while the app is built, exits 1 with
// the problem and binds nothing. The test holds PORT itself before spawning, so a start that bound first would print
// EADDRINUSE instead of the problem. Spawns the built CLI (`pnpm build` first).

/**
 * Within this a start has run only its environment check: a connect to a non-routable host has no client timeout and
 * waits on the OS's (over a minute). The margin is for a loaded machine, where the spawn alone has passed 2 s.
 */
const CHECKED_WITHIN_MS = 10_000

let cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})

/** A listener of the test's own on a free port of `host`: the port `start` is told to use. */
async function holdPort(host: string): Promise<number> {
  const server: Server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ port: 0, host, exclusive: true }, () => resolve())
  })
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return (server.address() as { port: number }).port
}

describe('AC-2: start refuses before it binds or builds', () => {
  it('AC-2: commandStore postgres with DATABASE_URL at a non-routable address and NYMBAL_SECRETS_KEY missing exits 1 within 10 s, naming the key, on a port the test holds, with no storefront started', async () => {
    const raw = storeConfig({ commandStore: 'postgres' })
    const project = storeProject(raw)
    cleanup.push(() => project.remove())
    const stand = await upstream(project.dir)
    cleanup.push(() => stand.close())
    const port = await holdPort('0.0.0.0')
    const password = `pw${randomBytes(12).toString('hex')}`
    const env = startEnv({
      PORT: String(port),
      DATABASE_URL: `postgres://shop:${password}@10.255.255.1:5432/shop`,
      NYMBAL_SECRETS_KEY: undefined,
      NYMBAL_STOREFRONT_ENTRY: stand.entry,
    })
    const problems: string[] = checkStartEnv(nymbalConfigSchema.parse(raw), env)

    const started = Date.now()
    const run = await runCli(['start'], { cwd: project.dir, env, timeoutMs: 15_000 })
    const took = Date.now() - started

    expect(run.code, run.out).toBe(1)
    expect(took, run.out).toBeLessThan(CHECKED_WITHIN_MS)
    expect(problems.map((line) => line.includes('NYMBAL_SECRETS_KEY'))).toEqual([true])
    expect(
      problems.filter((line) => !run.out.includes(line)),
      run.out,
    ).toEqual([])
    expect(run.out).not.toMatch(/EADDRINUSE/)
    expect(run.out).not.toContain(password)
    expect(stand.started()).toBe(0)
  }, 30_000)

  it('AC-2: a settings row saved under another key passes the environment check, then the ConfigError while the app is built exits 1 naming the slot and path, binding nothing and starting no storefront', async () => {
    const commerce = { ai: { provider: 'anthropic' } }
    const project = storeProject(
      settingsConfigInput('sqlite', commerce),
      workspace('@nymbalhq/ai-anthropic'),
    )
    cleanup.push(() => project.remove())
    const db = join(project.dir, 'nymbal.db')
    const savedUnder = secretsKey()
    const startedWith = secretsKey()
    const apiKey = `sk-ant-start-${randomBytes(12).toString('hex')}`
    cleanup.push(setEnv({ NYMBAL_SECRETS_KEY: savedUnder, ANTHROPIC_API_KEY: undefined }))
    await saveSettings(
      { dialect: 'sqlite', target: db, config: settingsConfig('sqlite', commerce) },
      [['ai', 'apiKey', apiKey]],
    )
    const stand = await upstream(project.dir)
    cleanup.push(() => stand.close())
    // settingsConfigInput binds http.host 127.0.0.1.
    const port = await holdPort('127.0.0.1')

    const run = await runCli(['start'], {
      cwd: project.dir,
      env: startEnv({
        PORT: String(port),
        NYMBAL_SQLITE_PATH: db,
        NYMBAL_SECRETS_KEY: startedWith,
        ANTHROPIC_API_KEY: undefined,
        NYMBAL_STOREFRONT_ENTRY: stand.entry,
      }),
      timeoutMs: 30_000,
    })

    expect(run.code, run.out).toBe(1)
    expect(run.out).toContain('ai.apiKey')
    expect(run.out).not.toMatch(/EADDRINUSE/)
    expect([apiKey, savedUnder, startedWith].filter((v) => run.out.includes(v))).toEqual([])
    expect(stand.started()).toBe(0)
  }, 60_000)

  it('AC-2: with NODE_ENV unset, start runs as production: a store on the stub payments and the default JWT secret exits 1 naming both refusals, binding nothing and starting no storefront', async () => {
    const project = storeProject(storeConfig())
    cleanup.push(() => project.remove())
    const stand = await upstream(project.dir)
    cleanup.push(() => stand.close())
    const port = await holdPort('0.0.0.0')

    const run = await runCli(['start'], {
      cwd: project.dir,
      env: startEnv({
        PORT: String(port),
        NODE_ENV: undefined,
        // The default secret is refused only while no NYMBAL_JWT_SECRET replaces it; none is inherited here.
        NYMBAL_JWT_SECRET: undefined,
        NYMBAL_STOREFRONT_ENTRY: stand.entry,
      }),
      timeoutMs: 30_000,
    })

    expect(run.code, run.out).toBe(1)
    expect(run.out).toContain('config.production_stub_payments')
    expect(run.out).toContain('config.production_default_jwt_secret')
    expect(run.out).not.toMatch(/EADDRINUSE/)
    expect(stand.started()).toBe(0)
  }, 60_000)
})
