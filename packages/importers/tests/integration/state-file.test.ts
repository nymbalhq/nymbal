import { spawn } from 'node:child_process'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendJournal,
  freshState,
  ImportStateError,
  journalPathFor,
  loadState,
  saveState,
  type ImportEntity,
  type ImportState,
} from '@nymbalhq/importers'

// The import's state file and its journal, through the built package (`pnpm build`): a save a process is killed in
// the middle of, a file that cannot be read, and a journal whose last line was cut.

const IMPORTERS_DIST = fileURLToPath(new URL('../../dist/index.js', import.meta.url))
const STATE = '.nymbal-migration.json'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nymbal-state-'))
  dirs.push(dir)
  return dir
}

/** What a load comes to: the state it resolves, or what it rejects with. */
async function loaded(path: string) {
  return loadState(path).then(
    (state) => ({ resolved: state }) as const,
    (error: unknown) => ({ rejected: error }) as const,
  )
}

describe('AC-9: a save killed half way leaves a whole state', () => {
  // The child saves two states of over 5 MB over each other until it is killed. Each holds one marker as its first
  // product id, so the file at the path tells which save it is.
  const CHILD = `
    const { freshState, saveState } = await import(process.env.IMPORTERS_DIST)
    const big = (marker) => {
      const s = freshState()
      s.importedIds.products.push(marker)
      for (let i = 0; i < 140000; i++) s.importedIds.products.push(marker + '-' + String(i).padStart(12, '0'))
      return s
    }
    const states = [big('new'), big('previous')]
    process.stdout.write('saving\\n')
    for (let n = 0; ; n++) await saveState(process.env.STATE_PATH, states[n % 2])
  `

  async function killedMidSave(statePath: string, delayMs: number): Promise<void> {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], {
      env: { ...process.env, IMPORTERS_DIST, STATE_PATH: statePath },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('saving')) resolve()
      })
      child.once('exit', (code) =>
        reject(new Error(`the saving child exited (${code}) before saving`)),
      )
    })
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    child.kill('SIGKILL')
    await exited
  }

  it('AC-9: a child saving a state of 5 MB or more over a previous one, SIGKILLed after a random delay, leaves a file that parses as one of the two and that loadState returns', async () => {
    await fc.assert(
      // Unbiased: fast-check's integers lean towards the bounds, and a kill at 0 ms lands before the first write.
      fc.asyncProperty(fc.noBias(fc.integer({ min: 0, max: 80 })), async (delayMs) => {
        const dir = await tempDir()
        const statePath = join(dir, STATE)
        const previous = freshState()
        previous.importedIds.products.push('previous')
        await saveState(statePath, previous)

        await killedMidSave(statePath, delayMs)

        const raw = await readFile(statePath, 'utf8')
        const parsed = (() => {
          try {
            return JSON.parse(raw) as ImportState
          } catch (error) {
            return `not JSON (${raw.length} bytes): ${String(error)}`
          }
        })()
        const marker = typeof parsed === 'string' ? parsed : parsed.importedIds.products[0]
        expect(['previous', 'new']).toContain(marker)
        const state = await loadState(statePath)
        expect(state?.importedIds.products[0]).toBe(marker)
        expect(state?.importedIds.products.length).toBe(
          (parsed as ImportState).importedIds.products.length,
        )
      }),
      { numRuns: 20 },
    )
  }, 120_000)
})

describe('AC-10: a state file that cannot be read stops the run', () => {
  it('AC-10: truncated JSON and a {} without importedIds each reject with an ImportStateError naming the path; an absent file is still null', async () => {
    const dir = await tempDir()
    const statePath = join(dir, STATE)
    const whole = JSON.stringify(freshState(), null, 2)

    const outcomes = []
    for (const body of [whole.slice(0, Math.floor(whole.length / 2)), '{}']) {
      await writeFile(statePath, body)
      outcomes.push(await loaded(statePath))
    }
    await rm(statePath)
    const absent = await loaded(statePath)

    expect(outcomes).toMatchObject([
      { rejected: { path: statePath } },
      { rejected: { path: statePath } },
    ])
    for (const o of outcomes) {
      expect('rejected' in o && o.rejected).toBeInstanceOf(ImportStateError)
    }
    expect(absent).toEqual({ resolved: null })
  })
})

describe('AC-11: the journal folds into the state', () => {
  const ENTITIES: ImportEntity[] = ['categories', 'products', 'customers', 'orders', 'reviews']
  /** The maps the fold restores beside importedIds, by entity. */
  const MAP: Partial<Record<ImportEntity, keyof ImportState>> = {
    categories: 'wcToNymbalCategory',
    products: 'wcToNymbalProduct',
    customers: 'wcToNymbalCustomer',
  }

  interface Created {
    entity: ImportEntity
    id: string
    wcId: number
  }

  const created = fc
    .array(fc.constantFrom(...ENTITIES), { minLength: 1, maxLength: 30 })
    .map((entities) =>
      entities.map((entity, i): Created => ({ entity, id: `${entity}-${i}`, wcId: 1000 + i })),
    )

  const journal = fc
    .tuple(created, fc.nat(), fc.array(fc.nat()), fc.nat(), fc.boolean())
    .map(([drawn, checkpointed, removedPicks, cutAt, cutRemoval]) => {
      // The last whole line is either a creation or a removal, and that line is the one cut.
      const removedAll = [...new Set(removedPicks.map((p) => drawn[p % drawn.length]!))]
      const tearRemoval = cutRemoval && removedAll.length > 0
      const torn = tearRemoval ? removedAll[removedAll.length - 1]! : drawn[drawn.length - 1]!
      const records = tearRemoval ? drawn : drawn.slice(0, -1)
      const removed = tearRemoval ? removedAll.slice(0, -1) : removedAll
      const inState = records.slice(0, checkpointed % (records.length + 1))
      const tornLine = JSON.stringify(
        tearRemoval
          ? { entity: torn.entity, id: torn.id, op: 'removed' }
          : { entity: torn.entity, id: torn.id, wcId: torn.wcId },
      )
      return {
        records,
        inState,
        removed,
        torn: tornLine.slice(0, 1 + (cutAt % (tornLine.length - 1))),
      }
    })

  it('AC-11: a journal whose last line is cut mid-JSON folds up to its last whole line, restoring importedIds and the WooCommerce maps, and folding it again gives the same state', async () => {
    await fc.assert(
      fc.asyncProperty(journal, async ({ records, inState, removed, torn }) => {
        const dir = await tempDir()
        const statePath = join(dir, STATE)
        const base = freshState()
        for (const r of inState) {
          base.importedIds[r.entity].push(r.id)
          const map = MAP[r.entity]
          if (map) (base[map] as Record<string, string>)[r.wcId] = r.id
        }
        await saveState(statePath, base)
        for (const r of records) await appendJournal(statePath, r)
        for (const r of removed) {
          await appendFile(
            journalPathFor(statePath),
            `${JSON.stringify({ entity: r.entity, id: r.id, op: 'removed' })}\n`,
          )
        }
        await appendFile(journalPathFor(statePath), torn)

        const folded = await loadState(statePath)

        const gone = new Set(removed.map((r) => r.id))
        const kept = [...inState, ...records].filter((r) => !gone.has(r.id))
        for (const e of ENTITIES) {
          const expected = [...new Set(kept.filter((r) => r.entity === e).map((r) => r.id))].sort()
          expect([...folded!.importedIds[e]].sort(), e).toEqual(expected)
        }
        const mapped = kept.filter((r) => MAP[r.entity] !== undefined)
        expect(
          mapped.map((r) => (folded![MAP[r.entity]!] as Record<string, string>)[r.wcId]),
        ).toEqual(mapped.map((r) => r.id))

        expect(await loadState(statePath)).toEqual(folded)
        await saveState(statePath, folded!)
        expect(await loadState(statePath)).toEqual(folded)
      }),
      { numRuns: 20 },
    )
  })

  it('AC-11: the journal sits beside the state file as .nymbal-migration.journal', async () => {
    const dir = await tempDir()
    const statePath = join(dir, STATE)
    await saveState(statePath, freshState())
    await appendJournal(statePath, { entity: 'products', id: 'p-1', wcId: 7 })

    const lines = (await readFile(join(dir, '.nymbal-migration.journal'), 'utf8'))
      .trim()
      .split('\n')

    expect(journalPathFor(statePath)).toBe(join(dir, '.nymbal-migration.journal'))
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      { entity: 'products', id: 'p-1', wcId: 7 },
    ])
    expect((await loadState(statePath))!.wcToNymbalProduct).toEqual({ 7: 'p-1' })
  })
})
