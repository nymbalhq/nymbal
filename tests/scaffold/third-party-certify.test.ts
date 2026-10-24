import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

// AC-7: in scripts/scaffold-clean.sh's Verdaccio flow (the CI job scaffold-clean runs this project after the script
// has published every public package), a directory outside the workspace installs `nymbal`, `@nymbalhq/contract-tests`
// and vitest from the registry the script set up, plus the third-party fixture (tests/fixtures/third-party-search)
// from a tarball, names the fixture on its search slot, and `npx nymbal test:contracts --package <fixture>` exits 0
// with the certified line. It installs at the version the scaffold resolved, so it certifies with exactly what was
// published.
//
//   NYMBAL_SCAFFOLD_DIR   the scaffolded project (its node_modules holds the published version)
//   npm_config_registry   the registry the script published to, exported by scaffold-clean.sh with its userconfig

const SCAFFOLD_DIR = process.env['NYMBAL_SCAFFOLD_DIR']
const REGISTRY = process.env['npm_config_registry']
if (!SCAFFOLD_DIR || !REGISTRY) {
  throw new Error(
    'AC-7 needs NYMBAL_SCAFFOLD_DIR and npm_config_registry (the local registry the packages were published to). ' +
      'Run it through scripts/scaffold-clean.sh <astro|nextjs>, which publishes, scaffolds and sets both.',
  )
}
const DIR: string = SCAFFOLD_DIR
const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const FIXTURE = join(REPO, 'tests', 'fixtures', 'third-party-search')
const PKG = '@acme/nymbal-search'

const project = mkdtempSync(join(tmpdir(), 'contracts-certify-published-'))
afterAll(() => rmSync(project, { recursive: true, force: true }))

/** The npm a user has: no Vitest variables, so the certifying run is not taken for this one. */
function userEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
  delete env['NODE_ENV']
  delete env['TEST']
  delete env['NODE_PATH']
  for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key]
  return env
}

function npm(args: string[], timeout = 300_000) {
  const res = spawnSync('npm', args, { cwd: project, encoding: 'utf8', env: userEnv(), timeout })
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

describe('AC-7: a store outside the workspace certifies a third-party adapter with the published packages', () => {
  it('AC-7: nymbal, @nymbalhq/contract-tests and vitest from the registry, the fixture from its tarball: `nymbal test:contracts --package` exits 0 with `certified … (search): N cases passed`', () => {
    const published = (
      JSON.parse(readFileSync(join(DIR, 'node_modules', 'nymbal', 'package.json'), 'utf8')) as {
        version: string
      }
    ).version
    writeFileSync(
      join(project, 'package.json'),
      `${JSON.stringify({ name: 'contracts-certify', private: true, type: 'module' }, null, 2)}\n`,
    )
    const packed = npm(['pack', FIXTURE, '--pack-destination', project])
    const tarball = readdirSync(project).find((f) => f.endsWith('.tgz'))
    writeFileSync(
      join(project, 'nymbal.config.ts'),
      `export default ${JSON.stringify({
        store: { name: 'Test Store', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
        template: 'astro',
        infrastructure: {
          commandStore: 'sqlite',
          documentStore: 'in-memory',
          eventBus: 'in-process',
        },
        security: { adapter: 'middleware' },
        commerce: {
          payments: { provider: 'native' },
          email: { provider: 'native' },
          reviews: { provider: 'native' },
          search: { provider: 'custom', package: PKG, config: {} },
          analytics: { provider: 'native' },
          shipping: { provider: 'native' },
          tax: { provider: 'native' },
          ai: { provider: 'none' },
        },
        http: { adapter: 'fastify' },
        deployment: { strategy: 'standard' },
      })}\n`,
    )
    const install = npm([
      'install',
      '--no-audit',
      '--no-fund',
      `nymbal@${published}`,
      `@nymbalhq/contract-tests@${published}`,
      'vitest@^3',
      `./${tarball ?? 'missing.tgz'}`,
    ])
    const run = npm(['exec', '--no', '--', 'nymbal', 'test:contracts', '--package', PKG])
    const certified = /^certified (\S+) \((\w+)\): (\d+) cases passed$/m.exec(run.out)

    expect(packed.status, packed.out).toBe(0)
    expect(install.status, install.out.slice(-3000)).toBe(0)
    expect(run.status, run.out.slice(-3000)).toBe(0)
    expect(certified?.slice(1, 3), run.out.slice(-3000)).toEqual([PKG, 'search'])
    expect(Number(certified?.[3])).toBeGreaterThan(0)
  }, 600_000)
})
