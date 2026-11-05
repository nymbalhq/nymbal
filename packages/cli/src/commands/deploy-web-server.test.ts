import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { cliEnv, runCli } from '../../../../tests/support/doctor.js'
import { storeConfig, storeProject } from '../../../../tests/support/start.js'
import { webServerRecipe } from './deploy-web-server.js'

// `nymbal deploy nginx|apache|caddy` writes a web server config for the store's own server from NYMBAL_PUBLIC_URL (the
// server name) and PORT (the upstream on loopback), prints the steps and runs nothing. A setting it cannot use is
// refused before anything is written. The CLI cases spawn the built CLI (`pnpm build` first); that the configs work
// in front of a real API is tests/stores/web-servers.test.ts.

const SERVERS = ['nginx', 'apache', 'caddy'] as const
type WebServer = (typeof SERVERS)[number]
const FILES: Record<WebServer, string> = {
  nginx: join('deploy', 'nginx.conf'),
  apache: join('deploy', 'apache.conf'),
  caddy: join('deploy', 'Caddyfile'),
}
const PUBLIC = 'https://shop.example'

let cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})

/** A store project whose .env holds `dotEnv`; the child sees neither NYMBAL_PUBLIC_URL nor PORT from this shell. */
function project(dotEnv: Record<string, string>) {
  const p = storeProject(storeConfig())
  cleanup.push(() => p.remove())
  writeFileSync(
    join(p.dir, '.env'),
    `${Object.entries(dotEnv)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')}\n`,
  )
  const env = cliEnv({ NYMBAL_PUBLIC_URL: undefined, PORT: undefined })
  return {
    dir: p.dir,
    deploy: (server: WebServer, ...flags: string[]) =>
      runCli(['deploy', server, ...flags], { cwd: p.dir, env }),
  }
}

describe('AC-12: nymbal deploy writes the web server config', () => {
  for (const server of SERVERS) {
    it(`AC-12: deploy ${server} with NYMBAL_PUBLIC_URL ${PUBLIC} in .env writes ${FILES[server]} with exactly webServerRecipe's content for upstream 127.0.0.1:3001 (127.0.0.1:8080 with PORT=8080) and prints its steps`, async () => {
      const onDefault = project({ NYMBAL_PUBLIC_URL: PUBLIC })
      const onPort = project({ NYMBAL_PUBLIC_URL: PUBLIC, PORT: '8080' })

      const runs = [await onDefault.deploy(server), await onPort.deploy(server)]
      const expected = ['127.0.0.1:3001', '127.0.0.1:8080'].map((upstream) =>
        webServerRecipe(server, { publicUrl: PUBLIC, upstream }),
      )
      const written = [onDefault.dir, onPort.dir].map((dir) => {
        const path = join(dir, FILES[server])
        return existsSync(path) ? readFileSync(path, 'utf8') : '(not written)'
      })

      expect(
        runs.map((r) => r.code),
        runs[0]!.out.slice(-2000),
      ).toEqual([0, 0])
      expect(expected.map((r) => r.file)).toEqual([FILES[server], FILES[server]])
      expect(written).toEqual(expected.map((r) => r.content))
      expect(written[0]).not.toBe(written[1])
      for (const [i, run] of runs.entries()) {
        expect(run.out).toMatch(new RegExp(`✓ wrote \\S*${FILES[server].replace('.', '\\.')}`))
        expect(expected[i]!.steps.filter((step: string) => !run.out.includes(step))).toEqual([])
      }
    }, 60_000)
  }

  it('AC-12: NYMBAL_PUBLIC_URL unset, or https://shop.example/path, exits 1 naming it and writes nothing; --real-ip-from 10.0.0.0/33 exits 1 naming the entry and writes nothing', async () => {
    const outcomes: Array<{ code: number; names: boolean; wrote: boolean }> = []
    for (const server of SERVERS) {
      for (const [dotEnv, flags, named] of [
        [{}, [], 'NYMBAL_PUBLIC_URL'],
        [{ NYMBAL_PUBLIC_URL: `${PUBLIC}/path` }, [], 'NYMBAL_PUBLIC_URL'],
        [{ NYMBAL_PUBLIC_URL: PUBLIC }, ['--real-ip-from', '10.0.0.0/33'], '10.0.0.0/33'],
      ] as const) {
        const p = project(dotEnv)
        const run = await p.deploy(server, ...flags)
        outcomes.push({
          code: run.code,
          names: run.out.includes(named),
          wrote: existsSync(join(p.dir, 'deploy')),
        })
      }
    }

    expect(outcomes).toEqual(outcomes.map(() => ({ code: 1, names: true, wrote: false })))
  }, 120_000)

  it('AC-12: --real-ip-from 0.0.0.0/0 or ::/0 (trusting every address’s header) exits 1 naming the entry and writes nothing, while --real-ip-from 10.0.0.0/8 writes the file', async () => {
    const outcomes: Array<{ code: number; names: boolean; wrote: boolean }> = []
    for (const server of SERVERS) {
      for (const everyone of ['0.0.0.0/0', '::/0']) {
        const p = project({ NYMBAL_PUBLIC_URL: PUBLIC })
        const run = await p.deploy(server, '--real-ip-from', `10.0.0.0/8,${everyone}`)
        outcomes.push({
          code: run.code,
          names: run.out.includes(everyone),
          wrote: existsSync(join(p.dir, 'deploy')),
        })
      }
    }
    const ranged = project({ NYMBAL_PUBLIC_URL: PUBLIC })
    const accepted = await ranged.deploy('nginx', '--real-ip-from', '10.0.0.0/8')

    expect(outcomes).toEqual(outcomes.map(() => ({ code: 1, names: true, wrote: false })))
    expect(accepted.code, accepted.out.slice(-2000)).toBe(0)
    expect(existsSync(join(ranged.dir, FILES.nginx))).toBe(true)
  }, 120_000)
})

describe('AC-12: webServerRecipe', () => {
  const label = fc.stringMatching(/^[a-z][a-z0-9-]{0,14}[a-z0-9]$/)
  const host = fc
    .tuple(label, fc.constantFrom('example', 'test', 'shop', 'co.uk'))
    .map(([l, tld]) => `${l}.${tld}`)

  it('AC-12: property: over generated host names and ports, each file names that host and that upstream port and no other', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SERVERS),
        fc.uniqueArray(host, { minLength: 2, maxLength: 2 }),
        fc.integer({ min: 1024, max: 65535 }),
        (server, [name, other], port) => {
          fc.pre(!name!.includes(other!) && !name!.includes('shop.example'))
          const { content } = webServerRecipe(server, {
            publicUrl: `https://${name}`,
            upstream: `127.0.0.1:${port}`,
          })
          const upstreamPorts = [...content.matchAll(/127\.0\.0\.1:(\d+)/g)].map((m) =>
            Number(m[1]),
          )

          expect(content).toContain(name!)
          expect(content).not.toContain(other!)
          expect(content).not.toContain('shop.example')
          expect(upstreamPorts.length).toBeGreaterThanOrEqual(1)
          expect(upstreamPorts).toEqual(upstreamPorts.map(() => port))
        },
      ),
      { numRuns: 150 },
    )
  })

  it('AC-12: the steps name http.host 127.0.0.1 and NYMBAL_TRUSTED_PROXIES=loopback; for nginx and Apache they obtain the certificate before the site is enabled, at the rendered certificate paths', () => {
    const recipes = SERVERS.map((server) =>
      webServerRecipe(server, { publicUrl: PUBLIC, upstream: '127.0.0.1:3001' }),
    )
    const at = (steps: string[], pattern: RegExp) => steps.findIndex((s) => pattern.test(s))

    for (const { steps } of recipes) {
      const text = steps.join('\n')
      expect(text).toMatch(/http\.host[^\n]*127\.0\.0\.1/)
      expect(text).toContain('NYMBAL_TRUSTED_PROXIES=loopback')
    }
    for (const { steps, content } of recipes.slice(0, 2)) {
      const certificate = at(steps, /certbot/)
      const enabled = at(steps, /a2ensite|sites-enabled/)
      expect(certificate).toBeGreaterThanOrEqual(0)
      expect(enabled).toBeGreaterThan(certificate)
      expect(content).toContain('/etc/letsencrypt/live/shop.example/fullchain.pem')
      expect(content).toContain('/etc/letsencrypt/live/shop.example/privkey.pem')
    }
  })
})
