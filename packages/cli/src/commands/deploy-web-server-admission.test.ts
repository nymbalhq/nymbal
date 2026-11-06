import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cliEnv, runCli } from '../../../../tests/support/doctor.js'
import { storeConfig, storeProject } from '../../../../tests/support/start.js'
import { workspace } from '../../../../tests/support/project.js'
import { webServerRecipe, type WebServerOptions } from './deploy-web-server.js'

// `nymbal deploy nginx|apache|caddy` writes an admission list (only connections from listed addresses reach the API)
// on a Cloudflare store alone: elsewhere the file has none. A --real-ip-from entry that holds every IPv4 address in
// IPv4-mapped form is refused as /0 is. Spawns the built CLI (`pnpm build` first).

const SERVERS = ['nginx', 'apache', 'caddy'] as const
type WebServer = (typeof SERVERS)[number]
const FILES: Record<WebServer, string> = {
  nginx: join('deploy', 'nginx.conf'),
  apache: join('deploy', 'apache.conf'),
  caddy: join('deploy', 'Caddyfile'),
}
const PUBLIC = 'https://shop.example'
const UPSTREAM = '127.0.0.1:3001'

let cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})

function project(adapter: 'cloudflare' | 'middleware') {
  const raw = storeConfig() as { security: Record<string, unknown> }
  const p = storeProject(
    adapter === 'cloudflare'
      ? {
          ...raw,
          security: {
            ...raw.security,
            adapter,
            cloudflare: { zoneId: 'zone-web', apiToken: 'token-web' },
          },
        }
      : raw,
    workspace('@nymbalhq/security-cloudflare'),
  )
  cleanup.push(() => p.remove())
  writeFileSync(join(p.dir, '.env'), `NYMBAL_PUBLIC_URL=${PUBLIC}\n`)
  const env = cliEnv({ NYMBAL_PUBLIC_URL: undefined, PORT: undefined })
  return {
    dir: p.dir,
    written: (server: WebServer): string | null => {
      const path = join(p.dir, FILES[server])
      return existsSync(path) ? readFileSync(path, 'utf8') : null
    },
    deploy: (server: WebServer, ...flags: string[]) =>
      runCli(['deploy', server, ...flags], { cwd: p.dir, env }),
  }
}

/** webServerRecipe with the admission list the interface adds. */
const recipe = (server: WebServer, options: WebServerOptions & { allowFrom?: string[] }) =>
  webServerRecipe(server, options as WebServerOptions)

describe('AC-14: admission lists and what --real-ip-from refuses', () => {
  it("AC-14: a middleware project's file is the recipe with no admission list, which differs from the one with an allowFrom list", async () => {
    const written: Array<string | null> = []
    for (const server of SERVERS) {
      const p = project('middleware')
      const run = await p.deploy(server)
      expect(run.code, run.out.slice(-2000)).toBe(0)
      written.push(p.written(server))
    }
    const plain = SERVERS.map((s) => recipe(s, { publicUrl: PUBLIC, upstream: UPSTREAM }).content)
    const admitting = SERVERS.map(
      (s) =>
        recipe(s, { publicUrl: PUBLIC, upstream: UPSTREAM, allowFrom: ['192.0.2.0/24'] }).content,
    )

    expect(written).toEqual(
      SERVERS.map((s) => recipe(s, { publicUrl: PUBLIC, upstream: UPSTREAM }).content),
    )
    expect(admitting.filter((content, i) => content === plain[i])).toEqual([])
  }, 120_000)

  it('AC-14: --real-ip-from ::ffff:0.0.0.0/96, every IPv4 address in IPv4-mapped form, exits 1 naming the entry and writes nothing, as ::/0 does', async () => {
    const outcomes: Array<{ code: number; names: boolean; wrote: boolean }> = []
    for (const entry of ['::ffff:0.0.0.0/96', '::/0']) {
      const p = project('middleware')
      const run = await p.deploy(
        'nginx',
        '--real-ip-from',
        entry,
        '--real-ip-header',
        'CF-Connecting-IP',
      )
      outcomes.push({
        code: run.code,
        names: run.out.includes(entry),
        wrote: p.written('nginx') !== null,
      })
    }

    expect(outcomes[0]).toEqual(outcomes[1])
    expect(outcomes[0]).toEqual({ code: 1, names: true, wrote: false })
  }, 60_000)
})
