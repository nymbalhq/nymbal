import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RefreshTokenInsert } from '../../src/repositories/refresh-token.js'
import { createKernel, type Kernel } from '../support/kernel.js'
import { openRaw, type RawReader } from '../support/raw.js'

// The app runs the refresh-token sweeper: on a kernel booted with a 50 ms sweep, an expired row goes while a live head
// beside it stays. What is left is read on a second connection. The sweeper's own rules and stop() are proven beside
// it (src/sweepers/refresh-token-sweeper.test.ts).

const HOUR_MS = 3_600_000

let kernel: Kernel
let raw: RawReader

beforeAll(async () => {
  kernel = await createKernel({
    dialect: 'sqlite',
    appOptions: { refreshTokenSweep: { intervalMs: 50 } },
  })
  raw = openRaw('sqlite', kernel.target)
})

afterAll(async () => {
  await raw?.close()
  await kernel?.close()
})

function row(customerId: string, expiresInMs: number): RefreshTokenInsert {
  const now = Date.now()
  return {
    id: randomUUID(),
    customerId,
    tokenHash: randomUUID(),
    createdAt: new Date(now - 2 * HOUR_MS),
    expiresAt: new Date(now + expiresInMs),
  }
}

const present = async (ids: string[]): Promise<boolean[]> => {
  const found = new Set(
    (
      await raw.rows<{ id: string }>(
        `SELECT id FROM refresh_tokens WHERE id IN (${ids.map(() => '?').join(', ')})`,
        ids,
      )
    ).map((r) => r.id),
  )
  return ids.map((id) => found.has(id))
}

describe('AC-5: the app runs the refresh-token sweeper', () => {
  it('AC-5: booted with refreshTokenSweep.intervalMs 50, a row that expired an hour ago is gone within 2 s and a head inserted beside it stays', async () => {
    const customerId = randomUUID()
    const expired = row(customerId, -HOUR_MS)
    const head = row(customerId, 7 * 24 * HOUR_MS)
    await kernel.store.transaction(async (tx) => {
      await kernel.repos.refreshToken.insert(tx, expired)
      await kernel.repos.refreshToken.insert(tx, head)
    })
    expect(await present([expired.id, head.id]), 'both committed').toEqual([true, true])

    await vi.waitFor(
      async () => {
        expect((await present([expired.id]))[0], 'the expired row').toBe(false)
      },
      { timeout: 2000, interval: 50 },
    )

    expect(
      await present([expired.id, head.id]),
      'after the sweep: a row stays while unexpired',
    ).toEqual([expired, head].map((r) => r.expiresAt.getTime() > Date.now()))
  })
})
