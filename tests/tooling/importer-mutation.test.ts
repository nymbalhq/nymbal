// Reads: stryker.config.mjs, vitest.stryker.config.ts, mutation-ratchet.json
import { execFile, execFileSync } from 'node:child_process'
import { globSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { mutateSet } from '../../scripts/gate'

// The WooCommerce mappers turn source prices, stock and units into the store's catalogue. Stryker mutates them with the
// importers' mapper unit tests, and the ratchet holds each mapper's score: the four this work rewrote at 80% or more.
// The ratchet's own check (scripts/mutation-ratchet.ts) fails a run that scores a file below its entry.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const MAPPERS_DIR = 'packages/importers/src/woocommerce/mappers'
const FLOORED = ['money.ts', 'units.ts', 'product.ts', 'category.ts'].map(
  (f) => `${MAPPERS_DIR}/${f}`,
)
const exec = promisify(execFile)

/** The mapper sources: those tracked, and the two this work adds. */
function mapperSources(): string[] {
  const tracked = execFileSync('git', ['ls-files', MAPPERS_DIR], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter((p) => p.endsWith('.ts'))
  return [...new Set([...tracked, ...FLOORED])].sort()
}

/** The test files Vitest itself collects under `config`. */
async function vitestFiles(config: string): Promise<string[]> {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('VITEST') && !k.startsWith('NYMBAL_')) env[k] = v
  }
  const { stdout } = await exec(
    join(REPO, 'node_modules/.bin/vitest'),
    ['list', '--filesOnly', '--json', '--config', config],
    { cwd: REPO, env, maxBuffer: 64 * 1024 * 1024 },
  )
  const rows = JSON.parse(stdout.slice(stdout.indexOf('['))) as Array<{ file: string }>
  return rows.map((row) => relative(REPO, row.file)).sort()
}

describe('mutation testing of the WooCommerce mappers', () => {
  it('AC-11: every mapper source is in the unit mutate set, and the ratchet holds money, units, product and category at 80% or more', async () => {
    const sources = mapperSources()
    expect(await mutateSet(REPO, sources)).toEqual(sources)
    const ratchet = JSON.parse(readFileSync(join(REPO, 'mutation-ratchet.json'), 'utf8')) as {
      files: Record<string, number>
    }
    for (const file of FLOORED) {
      expect(ratchet.files[file], file).toBeGreaterThanOrEqual(80)
    }
  })

  it('AC-11: the Vitest config Stryker runs collects every importers mapper unit test', async () => {
    const mapperTests = globSync('packages/importers/tests/mappers/**/*.test.ts', {
      cwd: REPO,
    }).sort()
    expect(mapperTests.length).toBeGreaterThanOrEqual(5)
    const collected = new Set(await vitestFiles('vitest.stryker.config.ts'))
    expect(mapperTests.filter((t) => !collected.has(t))).toEqual([])
  }, 60_000)
})
