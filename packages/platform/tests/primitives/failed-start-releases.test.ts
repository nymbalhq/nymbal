import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { deleteUnder, redis, redisServerUrl, uniquePrefix } from '../../../../tests/support/redis'
import { createApp } from '../../src/app.js'
import { createLogger } from '../../src/logger.js'
import { kernelConfig } from '../support/kernel.js'
import { withInfrastructure } from '../support/primitive-graph.js'

// createApp opens the primitives' connections before it builds anything else. A start that fails after that must
// close them: a process that retries its start, or a test that expects a failure, would otherwise hold them open.
// The primitives use logical database 13, which nothing else in the suites selects, so the connections they open are
// the ones CLIENT LIST shows on it.

const server = redisServerUrl()
const prefix = uniquePrefix('failed-start')
const dir = mkdtempSync(join(tmpdir(), 'primitives-failed-start-'))

function onDb13(): string {
  const u = new URL(server)
  u.pathname = '/13'
  return u.toString()
}

/** The ids of connected clients that selected database 13, beside the one that asks. */
async function clientsOnDb13(): Promise<string[]> {
  const [list] = await redis(server, [['CLIENT', 'LIST']])
  return String(list)
    .split('\n')
    .filter((line) => / db=13 /.test(line))
    .map((line) => /^id=(\d+)/.exec(line)?.[1] ?? line)
}

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true })
  await deleteUnder(onDb13(), prefix)
})

describe('a failed createApp releases what it opened', () => {
  it('when the start fails after the Redis document store and the Redis Streams bus connect, their connections are closed', async () => {
    const before = await clientsOnDb13()
    const config = withInfrastructure(kernelConfig('sqlite'), {
      commandStore: 'sqlite',
      documentStore: { provider: 'redis' },
      eventBus: { provider: 'redis-streams' },
      redis: { url: onDb13(), prefix },
    })

    // A command store with no tables: the start fails once it reads the store, after the primitives are open.
    await expect(
      createApp(config, {
        sqlitePath: join(dir, 'unmigrated.sqlite'),
        logger: createLogger({ pretty: false, level: 'error' }),
      }),
    ).rejects.toThrow(/no such table/)

    await vi.waitFor(
      async () => expect((await clientsOnDb13()).sort()).toEqual([...before].sort()),
      { timeout: 3_000, interval: 100 },
    )
  }, 30_000)
})
