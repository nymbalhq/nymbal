import { spawnSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { CHAOS_ENV, runUntilKilled } from '@nymbalhq/proof-kit/chaos'
import {
  CHAOS_CHILD,
  chaosCase,
  delivered,
  envWithout,
  readRows,
  removeChaosCases,
  type ChildStep,
} from './fixtures/chaos'

// AC-6, AC-7 and AC-8: runUntilKilled and armChaos on a child that writes rows to a SQLite file and publishes events
// (tests/fixtures/chaos-child.mjs). The row written before the kill point must be in the reopened file, and the event
// at the kill point must never reach the child's subscriber.

const T = 'proof.target.v1'
const U = 'proof.other.v1'
const CHILD_TIMEOUT_MS = 20_000

const rowIds = (db: string): string[] =>
  readRows<{ id: string }>(db, 'SELECT id FROM rows ORDER BY rowid').map((r) => r.id)

afterAll(() => {
  removeChaosCases()
})

describe('AC-6: a kill before the publish of T', () => {
  const plan: ChildStep[] = [
    { op: 'write', id: 'row-1' },
    { op: 'publish', type: T },
  ]

  it('AC-6: point { beforePublish: T }: killed by SIGKILL, the row is in the reopened file, T was never delivered', async () => {
    const c = chaosCase()
    const run = await runUntilKilled({
      script: CHAOS_CHILD,
      args: c.args(plan),
      point: { beforePublish: T },
      timeoutMs: CHILD_TIMEOUT_MS,
    })

    expect({ killed: run.killed, signal: run.signal, timedOut: run.timedOut }, run.stderr).toEqual({
      killed: true,
      signal: 'SIGKILL',
      timedOut: false,
    })
    expect(rowIds(c.db)).toEqual(['row-1'])
    expect(delivered(c.marker)).not.toContain(T)
  }, 30_000)

  it('AC-6: control without a point: the same child exits 0, writes the same row and T is delivered', async () => {
    const killedCase = chaosCase()
    await runUntilKilled({
      script: CHAOS_CHILD,
      args: killedCase.args(plan),
      point: { beforePublish: T },
      timeoutMs: CHILD_TIMEOUT_MS,
    })
    const c = chaosCase()
    const control = spawnSync(process.execPath, [CHAOS_CHILD, ...c.args(plan)], {
      env: envWithout(CHAOS_ENV),
      encoding: 'utf8',
      timeout: CHILD_TIMEOUT_MS,
    })

    expect(control.status, control.stderr).toBe(0)
    expect(rowIds(c.db)).toEqual(rowIds(killedCase.db))
    expect(delivered(c.marker)).toEqual([T])
    expect(delivered(killedCase.marker).length).toBeLessThan(delivered(c.marker).length)
  }, 30_000)
})

describe('AC-7: nth, the wildcard, and publishBatch', () => {
  it('AC-7: nth: 2 kills at the second publish of T, not the first: the marker holds exactly one T', async () => {
    const c = chaosCase()
    const run = await runUntilKilled({
      script: CHAOS_CHILD,
      args: c.args([
        { op: 'write', id: 'row-1' },
        { op: 'publish', type: T },
        { op: 'write', id: 'row-2' },
        { op: 'publish', type: T },
      ]),
      point: { beforePublish: T, nth: 2 },
      timeoutMs: CHILD_TIMEOUT_MS,
    })

    expect({ killed: run.killed, signal: run.signal }, run.stderr).toEqual({
      killed: true,
      signal: 'SIGKILL',
    })
    expect(delivered(c.marker).filter((type) => type === T)).toHaveLength(1)
    expect(rowIds(c.db)).toEqual(['row-1', 'row-2'])
  }, 30_000)

  it("AC-7: '*' kills at the first publish of any type: nothing is delivered", async () => {
    const c = chaosCase()
    const run = await runUntilKilled({
      script: CHAOS_CHILD,
      args: c.args([
        { op: 'write', id: 'row-1' },
        { op: 'publish', type: U },
        { op: 'publish', type: T },
      ]),
      point: { beforePublish: '*' },
      timeoutMs: CHILD_TIMEOUT_MS,
    })

    expect({ killed: run.killed, signal: run.signal }, run.stderr).toEqual({
      killed: true,
      signal: 'SIGKILL',
    })
    expect(delivered(c.marker)).toEqual([])
    expect(rowIds(c.db)).toEqual(['row-1'])
  }, 30_000)

  it('AC-7: publishBatch is intercepted like publish: a batch holding T kills the child and T is never delivered', async () => {
    const c = chaosCase()
    const run = await runUntilKilled({
      script: CHAOS_CHILD,
      args: c.args([
        { op: 'write', id: 'row-1' },
        { op: 'batch', types: [U, T] },
      ]),
      point: { beforePublish: T },
      timeoutMs: CHILD_TIMEOUT_MS,
    })

    expect({ killed: run.killed, signal: run.signal }, run.stderr).toEqual({
      killed: true,
      signal: 'SIGKILL',
    })
    expect(delivered(c.marker)).not.toContain(T)
    expect(rowIds(c.db)).toEqual(['row-1'])
  }, 30_000)
})

describe('AC-8: a mis-armed or hung child never passes silently', () => {
  it('AC-8: a child that never reaches the point returns killed: false with its own exit code', async () => {
    const c = chaosCase()
    const exitCode = 7
    const run = await runUntilKilled({
      script: CHAOS_CHILD,
      args: c.args([
        { op: 'write', id: 'row-1' },
        { op: 'publish', type: U },
        { op: 'exit', code: exitCode },
      ]),
      point: { beforePublish: T },
      timeoutMs: CHILD_TIMEOUT_MS,
    })

    expect(
      { killed: run.killed, code: run.code, signal: run.signal, timedOut: run.timedOut },
      run.stderr,
    ).toEqual({ killed: false, code: exitCode, signal: null, timedOut: false })
    expect(delivered(c.marker)).toEqual([U])
  }, 30_000)

  it('AC-8: a child that hangs past timeoutMs is killed and returns timedOut: true, killed: false', async () => {
    const c = chaosCase()
    const timeoutMs = 500
    const started = performance.now()
    const run = await runUntilKilled({
      script: CHAOS_CHILD,
      args: c.args([{ op: 'write', id: 'row-1' }, { op: 'hang' }]),
      point: { beforePublish: T },
      timeoutMs,
    })
    const elapsed = performance.now() - started

    expect({ killed: run.killed, timedOut: run.timedOut }, run.stderr).toEqual({
      killed: false,
      timedOut: true,
    })
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 50)
    expect(elapsed).toBeLessThan(timeoutMs + 10_000)
  }, 30_000)
})
