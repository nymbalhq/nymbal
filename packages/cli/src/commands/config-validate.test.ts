import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { slotFolder, type Slot } from '@nymbalhq/config'
import repoConfig from '../../../../nymbal.config.js'
import { cliEnv, runCli } from '../../../../tests/support/doctor.js'

// AC-3: `nymbal config:validate` prints its summary line with each slot as its folder name (`document-store: redis`),
// never a camelCase key. A project of its own on the Redis document store and the Redis Streams bus; nothing connects.
// Spawns the built CLI (`pnpm build` first).

const INFRASTRUCTURE = {
  commandStore: 'sqlite',
  documentStore: { provider: 'redis' },
  eventBus: { provider: 'redis-streams' },
  redis: { url: 'redis://127.0.0.1:1', prefix: 'config-validate' },
} as const

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'nymbal-config-validate-'))
  writeFileSync(
    join(dir, 'nymbal.config.ts'),
    `export default ${JSON.stringify({ ...repoConfig, infrastructure: INFRASTRUCTURE }, null, 2)}\n`,
  )
})
afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

describe('AC-3: config:validate names slots in kebab case', () => {
  it('AC-3: on a project with redis, the summary prints document-store: redis and event-bus: redis-streams, and no camelCase key', async () => {
    const run = await runCli(['config:validate'], { cwd: dir, env: cliEnv() })
    const summary = run.out.split('\n').filter((l) => /\btemplate: /.test(l))

    expect(run.code, run.out).toBe(0)
    expect(summary, run.out).toHaveLength(1)
    for (const slot of ['documentStore', 'eventBus'] as const satisfies readonly Slot[]) {
      expect(summary[0]).toContain(`${slotFolder(slot)}: ${INFRASTRUCTURE[slot].provider}`)
    }
    expect(summary[0]!.match(/\b(documentStore|eventBus|commandStore)\b/g) ?? []).toEqual([])
  })
})
