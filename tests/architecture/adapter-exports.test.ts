// Reads: packages/adapters/**, packages/config/src/adapter-names.ts
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Slot } from '../../packages/types/src/index'
import { ADAPTER_CATALOGUE, slotFolder } from '../../packages/config/src/adapter-names'
import { ROOT, pnpmMembers } from './adapter-table'

// AC-5, the architecture half: each first-party adapter at packages/adapters/<folder>/<provider> exports `slot`, the
// slot whose slotFolder is <folder>, and `provider`, <provider>, so the kernel's check on load passes for every one of
// them and refuses any of them on another slot.

describe('AC-5: every first-party adapter says what it serves', () => {
  it('AC-5: each workspace adapter exports the slot and provider of its folder', async () => {
    const slotOf = new Map(
      (Object.keys(ADAPTER_CATALOGUE) as Slot[]).map((s) => [slotFolder(s), s]),
    )
    const adapters = pnpmMembers().filter((m) => /^packages\/adapters\/[^/]+\/[^/]+$/.test(m.dir))
    const seen = await Promise.all(
      adapters.map(async (m) => {
        const [, , folder = '', provider = ''] = m.dir.split('/')
        const mod = (await import(pathToFileURL(join(ROOT, m.dir, 'src', 'index.ts')).href)) as {
          slot?: unknown
          provider?: unknown
        }
        return {
          dir: m.dir,
          exported: { slot: mod.slot, provider: mod.provider },
          folder: { slot: slotOf.get(folder), provider },
        }
      }),
    )

    expect(seen.filter((s) => s.folder.slot === undefined).map((s) => s.dir)).toEqual([])
    expect(seen.map((s) => [s.dir, s.exported])).toEqual(seen.map((s) => [s.dir, s.folder]))
    expect(seen.length).toBe(12)
  }, 60_000)
})
