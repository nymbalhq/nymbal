import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cliEnv, runCli } from '../../../../tests/support/doctor.js'
import { storeConfig, storeProject } from '../../../../tests/support/start.js'
import { workspace } from '../../../../tests/support/project.js'
import { CLOUDFLARE_IPS } from '../../../adapters/security/cloudflare/src/ips.js'
import { webServerRecipe, type WebServerOptions } from './deploy-web-server.js'

// On a Cloudflare store, `nymbal deploy nginx|apache|caddy` admits only Cloudflare's published ranges (the snapshot
// the adapter ships), judged on the connection's own address, and reads the shopper from CF-Connecting-IP sent by
// them; its steps say which snapshot. A store cannot widen either by flag there. Spawns the built CLI (`pnpm build`
// first).

const SERVERS = ['nginx', 'apache', 'caddy'] as const
type WebServer = (typeof SERVERS)[number]
const FILES: Record<WebServer, string> = {
  nginx: join('deploy', 'nginx.conf'),
  apache: join('deploy', 'apache.conf'),
  caddy: join('deploy', 'Caddyfile'),
}
const PUBLIC = 'https://shop.example'
const UPSTREAM = '127.0.0.1:3001'
const RANGES = [...CLOUDFLARE_IPS.ipv4Cidrs, ...CLOUDFLARE_IPS.ipv6Cidrs]

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

describe('AC-14: a Cloudflare store’s web server admits only Cloudflare', () => {
  for (const server of SERVERS) {
    it(`AC-14: in a cloudflare project, deploy ${server} writes exactly webServerRecipe's content with realIpFrom and allowFrom the snapshot's ranges and realIpHeader CF-Connecting-IP, and its steps name the snapshot's fetchedAt and etag`, async () => {
      const p = project('cloudflare')
      const expected = recipe(server, {
        publicUrl: PUBLIC,
        upstream: UPSTREAM,
        realIpFrom: RANGES,
        allowFrom: RANGES,
        realIpHeader: 'CF-Connecting-IP',
      })
      const open = recipe(server, { publicUrl: PUBLIC, upstream: UPSTREAM })

      const run = await p.deploy(server)

      expect(run.code, run.out.slice(-2000)).toBe(0)
      expect(p.written(server)).toBe(expected.content)
      expect(expected.content).not.toBe(open.content)
      expect(
        [CLOUDFLARE_IPS.fetchedAt, CLOUDFLARE_IPS.etag].filter(
          (fact) => !run.stdout.includes(fact),
        ),
      ).toEqual([])
    }, 60_000)
  }

  it('AC-14: in a cloudflare project, --real-ip-from 10.0.0.0/8 or --real-ip-header X-Real-IP exits 1 naming the flag and writes nothing', async () => {
    const outcomes: Array<{ code: number; names: boolean; wrote: boolean }> = []
    for (const server of SERVERS) {
      for (const [flag, value] of [
        ['--real-ip-from', '10.0.0.0/8'],
        ['--real-ip-header', 'X-Real-IP'],
      ] as const) {
        const p = project('cloudflare')
        const run = await p.deploy(server, flag, value)
        outcomes.push({
          code: run.code,
          names: run.out.includes(flag),
          wrote: p.written(server) !== null,
        })
      }
    }

    expect(outcomes).toEqual(outcomes.map(() => ({ code: 1, names: true, wrote: false })))
  }, 120_000)
})
