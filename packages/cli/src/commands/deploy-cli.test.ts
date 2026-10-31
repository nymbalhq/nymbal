import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nymbalConfigSchema } from '@nymbalhq/config'
import { cliEnv, runCli } from '../../../../tests/support/doctor.js'
import { storeConfig, storeProject } from '../../../../tests/support/start.js'
import { flyRecipe, railwayRecipe } from './deploy.js'

// AC-10 (integration half): `nymbal deploy fly|railway` in a project whose .env holds secrets. With --dry-run it writes
// the recipe and prints the steps, and neither holds a .env value; without it and without the platform's CLI on PATH
// it exits 1 naming that CLI. Throughout, a listener of the test's own given as HTTP_PROXY and HTTPS_PROXY (with
// NODE_USE_ENV_PROXY=1) sees no connection. Spawns the built CLI (`pnpm build` first).

let cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})

/** A listener that counts the connections it is offered and answers none. */
async function proxyListener(): Promise<{ url: string; connections: () => number }> {
  let connections = 0
  const server: Server = createServer((socket) => {
    connections += 1
    socket.destroy()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    connections: () => connections,
  }
}

const secret = (label: string) => `${label}${randomBytes(18).toString('base64url')}`

/** A store project with a .env of secrets, a PATH holding only node, and a home of its own. */
async function deployProject() {
  const raw = storeConfig({
    commandStore: 'postgres',
    documentStore: { provider: 'redis' },
    eventBus: { provider: 'redis-streams' },
  })
  const project = storeProject(raw)
  cleanup.push(() => project.remove())
  const env = {
    NYMBAL_SECRETS_KEY: randomBytes(32).toString('base64'),
    DATABASE_URL: `postgres://shop:${secret('pg')}@db.internal:5432/shop`,
    REDIS_URL: `redis://:${secret('rd')}@cache.internal:6379/0`,
    NYMBAL_ADMIN_PASSWORD: secret('admin'),
    NYMBAL_JWT_SECRET: secret('jwt'),
  }
  writeFileSync(
    join(project.dir, '.env'),
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  )
  writeFileSync(join(project.dir, 'Dockerfile'), 'FROM node:26.12.1\n')
  const bin = join(project.dir, 'path-bin')
  mkdirSync(bin)
  symlinkSync(process.execPath, join(bin, 'node'))
  const home = join(project.dir, 'home')
  mkdirSync(home)
  const proxy = await proxyListener()
  const runEnv = cliEnv({
    PATH: bin,
    HOME: home,
    HTTP_PROXY: proxy.url,
    HTTPS_PROXY: proxy.url,
    http_proxy: proxy.url,
    https_proxy: proxy.url,
    NODE_USE_ENV_PROXY: '1',
    NO_PROXY: undefined,
    no_proxy: undefined,
    ...Object.fromEntries(Object.keys(env).map((k) => [k, undefined])),
  })
  return { project, env, runEnv, proxy, config: nymbalConfigSchema.parse(raw) }
}

describe('AC-10: deploy keeps .env values to itself and makes no network call unasked', () => {
  it('AC-10: deploy fly --dry-run and deploy railway --dry-run write the recipe and print its steps, and no .env value is in either file or the output; no connection is made', async () => {
    const { project, env, runEnv, proxy, config } = await deployProject()

    const fly = await runCli(['deploy', 'fly', '--dry-run'], { cwd: project.dir, env: runEnv })
    const railway = await runCli(['deploy', 'railway', '--dry-run'], {
      cwd: project.dir,
      env: runEnv,
    })
    const flyFile = join(project.dir, 'fly.toml')
    const railwayFile = join(project.dir, 'railway.json')
    const written = [flyFile, railwayFile].map((f) =>
      existsSync(f) ? readFileSync(f, 'utf8') : '',
    )
    const expectedSteps: string[] = [
      ...flyRecipe({ name: 'shop', root: project.dir, config }).steps,
      ...railwayRecipe({ name: 'shop', root: project.dir, config }).steps,
    ]

    expect(fly.code, fly.out).toBe(0)
    expect(railway.code, railway.out).toBe(0)
    expect(written[0]).toBe(flyRecipe({ name: 'shop', root: project.dir, config }).toml)
    expect(written[1]).toBe(railwayRecipe({ name: 'shop', root: project.dir, config }).json)
    expect(expectedSteps.filter((step) => !(fly.out + railway.out).includes(step))).toEqual([])
    expect(
      Object.values(env).filter((value) =>
        [...written, fly.out, railway.out].some((text) => text.includes(value)),
      ),
    ).toEqual([])
    expect(proxy.connections()).toBe(0)
  }, 60_000)

  for (const [platform, tool] of [
    ['fly', 'flyctl'],
    ['railway', 'railway'],
  ] as const) {
    it(`AC-10: deploy ${platform} without --dry-run and without ${tool} on PATH exits 1 naming ${tool}, with no connection made and no .env value printed`, async () => {
      const { project, env, runEnv, proxy } = await deployProject()

      const run = await runCli(['deploy', platform], { cwd: project.dir, env: runEnv })

      expect(run.code, run.out).toBe(1)
      expect(run.out).toMatch(new RegExp(`\\b${tool}\\b`))
      expect(run.out).not.toMatch(/Unknown command/i)
      expect(Object.values(env).filter((value) => run.out.includes(value))).toEqual([])
      expect(proxy.connections()).toBe(0)
    }, 60_000)
  }
})
