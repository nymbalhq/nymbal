import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import repoConfig from '../../../../nymbal.config.js'
import { cliEnv, runCli, type CliRun } from '../../../../tests/support/doctor.js'
import { project } from '../../../../tests/support/project.js'

// AC-9, the seed half: `nymbal seed` fills no package search index (it passes no search), so on a store whose search
// is a package it says how to fill it. The built CLI (`pnpm build` first), on a SQLite file per project.

// The kernel package in the project's node_modules, so seed finds its migrations as a store's does.
const PLATFORM = fileURLToPath(new URL('../../../platform', import.meta.url))
const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function seedWith(search: Record<string, unknown>): Promise<CliRun> {
  const dir = project({ '@nymbalhq/platform': PLATFORM }, { prefix: 'nymbal-seed-search-' })
  dirs.push(dir)
  const config = {
    ...repoConfig,
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    commerce: { ...repoConfig.commerce, search },
  }
  writeFileSync(
    join(dir, 'nymbal.config.ts'),
    `export default ${JSON.stringify(config, null, 2)}\n`,
  )
  return runCli(['seed'], {
    cwd: dir,
    env: cliEnv({ NYMBAL_SQLITE_PATH: join(dir, 'store.sqlite') }),
  })
}

const REPLAY_STEP = 'search: run `nymbal replay --to search` to fill algolia'
const seededLine = (out: string) => out.split('\n').find((l) => /seeded \d+ products/.test(l))

describe('AC-9: nymbal seed on a package search store', () => {
  it('AC-9: nymbal seed on an algolia store seeds the catalogue native would and prints the replay step that fills algolia; on a native store it prints no replay step', async () => {
    const [algolia, native] = await Promise.all([
      seedWith({ provider: 'algolia', config: { appId: 'SEEDAPP' } }),
      seedWith({ provider: 'native' }),
    ])

    expect(algolia.code, algolia.out).toBe(0)
    expect(native.code, native.out).toBe(0)
    expect(seededLine(native.out), native.out).toMatch(/seeded \d+ products across \d+ categories/)
    expect(seededLine(algolia.out), algolia.out).toBe(seededLine(native.out))
    expect(
      algolia.out.split('\n').filter((l) => l.includes(REPLAY_STEP)),
      algolia.out,
    ).toHaveLength(1)
    expect(native.out.split('\n').filter((l) => l.includes('nymbal replay --to search'))).toEqual(
      [],
    )
  }, 90_000)
})
