import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import type { AiAdapter, ProductSnapshot } from '@nymbalhq/types'
import { NIGHT_SHIFT_JOBS, type NightShiftJob } from '../../src/night-shift/jobs.js'
import { runNightShift } from '../../src/night-shift/runner.js'
import { contentRoleJob } from '../../src/roles/content.js'
import {
  contentAi,
  contentDeps,
  dayOf,
  goodCopy,
  json,
  productIn,
  roleWith,
  seedProduct,
  type ContentReply,
  type ContentRequest,
} from '../support/content-role.js'
import { createKernel, type Kernel } from '../support/kernel.js'
import { NOW, RUN_DAY, depsOf, insightRows, runRows } from '../support/night-shift.js'
import { openRaw, type RawReader } from '../support/raw.js'

// The content role as a night-shift job: it acts on its schedule day only, once per run day across runs, and its
// drafts become insights under its own job; createApp adds it to the night's jobs only when it is enabled and the
// store has an AI provider.

const JOB = 'role.content'
/** 03:30 in London (BST) on Monday 13 July 2026, the Tuesday after it, and the Monday a week later. */
const MONDAY = new Date('2026-07-13T02:30:00.000Z')
const TUESDAY = new Date('2026-07-14T02:30:00.000Z')
const NEXT_MONDAY = new Date('2026-07-20T02:30:00.000Z')

const kernels: Kernel[] = []
const raws: RawReader[] = []

afterEach(async () => {
  for (const raw of raws.splice(0)) await raw.close()
  for (const k of kernels.splice(0)) await k.close()
  vi.useRealTimers()
})

describe('AC-14: the role in the night shift', () => {
  it('AC-14: on a Monday run day the role asks the model and its run draft becomes an insight under role.content; a second night on that Monday asks nothing; a Tuesday asks nothing and drafts nothing; a week later a provider failure becomes an insight though the earlier run insight is still open', async () => {
    const k = await createKernel({ dialect: 'sqlite' })
    kernels.push(k)
    const raw = openRaw(k.dialect, k.target)
    raws.push(raw)
    const products: ProductSnapshot[] = []
    const replies: Record<string, ContentReply> = {
      'Alder Tote': {
        text: json({ ...goodCopy('Alder Tote'), seoTitle: 'Alder Tote in organic silk' }),
      },
      'Cedar Tote': { fail: true },
    }
    const model = contentAi((request: ContentRequest) => {
      const product = productIn(request, products)
      if (product === undefined) return { text: 'Which product?' }
      return replies[product.name] ?? { text: json(goodCopy(product.name)) }
    })
    const jobs: NightShiftJob[] = [contentRoleJob(contentDeps(k, model.ai))]

    products.push(await seedProduct(k, { name: 'Alder Tote', at: dayOf(0) }))
    await runNightShift(depsOf(k, jobs), MONDAY)
    const afterMonday = model.requests.length
    await runNightShift(depsOf(k, jobs), MONDAY)
    const afterSecondMonday = model.requests.length

    products.push(await seedProduct(k, { name: 'Birch Tote', at: dayOf(2) }))
    await runNightShift(depsOf(k, jobs), TUESDAY)
    const afterTuesday = model.requests.length

    products.push(await seedProduct(k, { name: 'Cedar Tote', at: dayOf(1) }))
    await runNightShift(depsOf(k, jobs), NEXT_MONDAY)

    expect([afterMonday, afterSecondMonday, afterTuesday]).toEqual([1, 1, 1])
    expect(model.requests.length).toBeGreaterThan(afterTuesday)
    expect(
      (await insightRows(raw, JOB)).map((r) => [r.subject, r.runDay, r.severity, r.status]),
    ).toEqual([
      ['run', '2026-07-13', 'info', 'open'],
      ['provider', '2026-07-20', 'warning', 'open'],
    ])
  })
})

const INTERVAL_MS = 1_000
const shippedIds = () => NIGHT_SHIFT_JOBS.map((j: NightShiftJob) => j.id).sort()

/** A kernel whose night shift ticks on a faked interval at NOW, its ai slot and content role as given. */
async function kernelWith(opts: {
  ai: 'custom' | 'none'
  enabled: boolean
  adapter?: AiAdapter
}): Promise<Kernel> {
  const k = await createKernel({
    dialect: 'sqlite',
    configure: (config) =>
      ({
        ...config,
        nightShift: { enabled: true, at: '03:00' },
        commerce: { ...config.commerce, ai: { provider: opts.ai } },
        agents: { ...config.agents, roles: { content: roleWith({ enabled: opts.enabled }) } },
      }) as unknown as NymbalConfig,
    appOptions: {
      nightShift: { intervalMs: INTERVAL_MS, now: () => NOW },
      relay: { intervalMs: 3_600_000 },
      ...(opts.adapter !== undefined && { adapters: { ai: opts.adapter } }),
    },
  })
  kernels.push(k)
  return k
}

describe('AC-15: createApp adds the role to the night’s jobs only when it can run', () => {
  it('AC-15: with the role enabled and an ai adapter the night runs role.content beside the shipped jobs; with the role disabled, or ai none, it runs the shipped jobs alone', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const model = contentAi(() => ({ text: json({ skip: true }) }))
    const enabled = await kernelWith({ ai: 'custom', enabled: true, adapter: model.ai })
    const disabled = await kernelWith({ ai: 'custom', enabled: false, adapter: model.ai })
    const noAi = await kernelWith({ ai: 'none', enabled: true })
    const readers = [enabled, disabled, noAi].map((k) => openRaw(k.dialect, k.target))
    raws.push(...readers)

    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    await vi.waitFor(
      async () => {
        for (const raw of readers)
          expect((await runRows(raw)).length).toBeGreaterThanOrEqual(NIGHT_SHIFT_JOBS.length)
      },
      { timeout: 10_000 },
    )
    await vi.advanceTimersByTimeAsync(10 * INTERVAL_MS)

    const jobsOf = async (raw: RawReader) => (await runRows(raw)).map((r) => r.job).sort()
    expect(await Promise.all(readers.map(jobsOf))).toEqual([
      [...shippedIds(), JOB].sort(),
      shippedIds(),
      shippedIds(),
    ])
    expect(new Set((await runRows(readers[0]!)).map((r) => r.runDay))).toEqual(new Set([RUN_DAY]))
  })
})
