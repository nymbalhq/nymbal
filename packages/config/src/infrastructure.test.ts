import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import { ConfigError } from '@nymbalhq/types'
import { KNOWN_INFRASTRUCTURE, loadConfig } from './index.js'

// Acceptance tests for P2-02 AC-1 (spec P2-02-primitives-are-protocols): the config lists what is built and nothing
// else. Every infrastructure slot × known value loads; any other value fails naming the slot and its list; `cloud` and
// `compute` fail saying they were removed and should be deleted; any other unknown key fails; postgres-jsonb needs the
// postgres command store and redis-streams a document store other than in-memory; no `media` means local-fs.
// Kills: a value that throws "planned for v1.0" at start, or a key that drives nothing, still loading.

const SLOTS = ['commandStore', 'documentStore', 'eventBus', 'media'] as const
type Slot = (typeof SLOTS)[number]

/** Decision 1, per slot. */
const SPEC_VALUES: Record<Slot, readonly string[]> = {
  commandStore: ['sqlite', 'postgres'],
  documentStore: ['in-memory', 'redis', 'postgres-jsonb'],
  eventBus: ['in-process', 'redis-streams'],
  media: ['local-fs'],
}

const EVERY_VALUE = new Set(Object.values(SPEC_VALUES).flat())
const KNOWN_KEYS = new Set<string>([...SLOTS, 'redis'])

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Infrastructure = Record<string, unknown>

function configWith(infrastructure: Infrastructure): Record<string, unknown> {
  return {
    store: { name: 'P2-02', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure,
    security: { adapter: 'middleware' },
    commerce: {
      payments: { provider: 'native' },
      email: { provider: 'native' },
      reviews: { provider: 'native' },
      search: { provider: 'native' },
      analytics: { provider: 'native' },
      shipping: { provider: 'native' },
      tax: { provider: 'native' },
      ai: { provider: 'none' },
    },
    http: { adapter: 'fastify', port: 3001 },
    deployment: { strategy: 'standard' },
  }
}

const BASE: Infrastructure = {
  commandStore: 'sqlite',
  documentStore: 'in-memory',
  eventBus: 'in-process',
}

/** The slot set to `value`, with the companions decision 1 requires so that only `value` is under test. */
function cell(slot: Slot, value: string): Infrastructure {
  const infra: Infrastructure = { ...BASE, [slot]: value }
  if (infra['documentStore'] === 'postgres-jsonb') infra['commandStore'] = 'postgres'
  if (infra['eventBus'] === 'redis-streams' && infra['documentStore'] === 'in-memory') {
    infra['documentStore'] = 'redis'
  }
  return infra
}

function project(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'p2-02-config-'))
  dirs.push(dir)
  writeFileSync(
    join(dir, 'nymbal.config.ts'),
    `export default ${JSON.stringify(config, null, 2)}\n`,
  )
  return dir
}

/** loadConfig's rejection, or null when it loaded. */
async function rejectionOf(config: unknown): Promise<unknown> {
  return loadConfig(project(config)).then(
    () => null,
    (error: unknown) => error,
  )
}

function messageOf(error: unknown): string {
  expect(error, 'loadConfig accepted it').toBeInstanceOf(ConfigError)
  return (error as ConfigError).message
}

function quoted(message: string, value: string): boolean {
  return [`'${value}'`, `"${value}"`, `\`${value}\``].some((q) => message.includes(q))
}

/** Value-shaped strings no slot lists: random names, and one-character typos of the listed ones. */
const unknownValue = fc
  .oneof(
    fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,24}$/),
    fc
      .tuple(fc.constantFrom(...EVERY_VALUE), fc.stringMatching(/^[a-z0-9-]$/), fc.nat())
      .map(([name, c, at]) => {
        const i = at % (name.length + 1)
        return `${name.slice(0, i)}${c}${name.slice(i)}`
      }),
  )
  .filter((s) => !EVERY_VALUE.has(s))

/** Key-shaped strings infrastructure does not know (cloud and compute have their own case). */
const unknownKey = fc
  .stringMatching(/^[a-z][a-zA-Z0-9]{0,15}$/)
  .filter((k) => !KNOWN_KEYS.has(k) && k !== 'cloud' && k !== 'compute' && !(k in {}))

describe('P2-02 AC-1: the infrastructure config lists what is built, and nothing else', () => {
  it('AC-1: KNOWN_INFRASTRUCTURE lists, per slot, exactly the values decision 1 names', () => {
    expect(Object.keys(KNOWN_INFRASTRUCTURE).sort()).toEqual([...SLOTS].sort())
    for (const slot of SLOTS) {
      expect([...KNOWN_INFRASTRUCTURE[slot]].sort(), slot).toEqual([...SPEC_VALUES[slot]].sort())
    }
  })

  it('AC-1: loadConfig accepts every slot × every known value and keeps the value it was given', async () => {
    const cells = SLOTS.flatMap((slot) => SPEC_VALUES[slot].map((value) => ({ slot, value })))
    expect(cells.length).toBe(Object.values(SPEC_VALUES).flat().length)
    for (const { slot, value } of cells) {
      const error = await rejectionOf(configWith(cell(slot, value)))
      expect(error, `${slot}: ${value}: ${String((error as Error | null)?.message)}`).toBeNull()
      const loaded = await loadConfig(project(configWith(cell(slot, value))))
      expect(
        (loaded.config.infrastructure as Record<string, unknown>)[slot],
        `${slot}: ${value}`,
      ).toBe(value)
    }
  })

  it('AC-1: any other value fails loadConfig with a ConfigError naming the slot, the value and every known value for the slot', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...SLOTS), unknownValue, async (slot, value) => {
        const message = messageOf(await rejectionOf(configWith({ ...BASE, [slot]: value })))

        expect(message).toMatch(new RegExp(`\\b${slot}\\b`))
        expect(quoted(message, value), `the message quotes ${value}: ${message}`).toBe(true)
        const unnamed = SPEC_VALUES[slot].filter((known) => !quoted(message, known))
        expect(unnamed, message).toEqual([])
      }),
      { numRuns: 40 },
    )
  })

  it.each(['cloud', 'compute'])(
    'AC-1: infrastructure.%s fails loadConfig with a ConfigError saying the key was removed and should be deleted',
    async (key) => {
      const values = key === 'cloud' ? ['local', 'aws', 'docker'] : ['in-process', 'lambda']
      for (const value of values) {
        const message = messageOf(await rejectionOf(configWith({ ...BASE, [key]: value })))

        expect(message).toMatch(new RegExp(`\\b${key}\\b`))
        expect(message, message).toMatch(/\bremoved\b/i)
        expect(message, message).toMatch(/\bdelete/i)
      }
    },
  )

  it('AC-1: any other unknown infrastructure key fails loadConfig with a ConfigError naming the key and the known slots', async () => {
    await fc.assert(
      fc.asyncProperty(unknownKey, async (key) => {
        const message = messageOf(await rejectionOf(configWith({ ...BASE, [key]: 'in-memory' })))

        expect(quoted(message, key), `the message quotes ${key}: ${message}`).toBe(true)
        const unnamed = SLOTS.filter((slot) => !message.includes(slot))
        expect(unnamed, message).toEqual([])
      }),
      { numRuns: 25 },
    )
  })

  it('AC-1: postgres-jsonb with sqlite and redis-streams with in-memory fail; every other combination of the known values loads', async () => {
    const combos = SPEC_VALUES.commandStore.flatMap((commandStore) =>
      SPEC_VALUES.documentStore.flatMap((documentStore) =>
        SPEC_VALUES.eventBus.map((eventBus) => ({ commandStore, documentStore, eventBus })),
      ),
    )
    expect(combos.length).toBe(
      SPEC_VALUES.commandStore.length *
        SPEC_VALUES.documentStore.length *
        SPEC_VALUES.eventBus.length,
    )
    for (const combo of combos) {
      const jsonbOnSqlite =
        combo.documentStore === 'postgres-jsonb' && combo.commandStore !== 'postgres'
      const streamsOnMemory =
        combo.eventBus === 'redis-streams' && combo.documentStore === 'in-memory'
      const error = await rejectionOf(configWith(combo))
      const label = JSON.stringify(combo)

      expect(error === null, `${label}: ${String((error as Error | null)?.message)}`).toBe(
        !jsonbOnSqlite && !streamsOnMemory,
      )
    }

    const jsonb = messageOf(
      await rejectionOf(
        configWith({
          commandStore: 'sqlite',
          documentStore: 'postgres-jsonb',
          eventBus: 'in-process',
        }),
      ),
    )
    expect(jsonb).toContain('postgres-jsonb')
    expect(jsonb).toMatch(/\bcommandStore\b/)
    const streams = messageOf(
      await rejectionOf(
        configWith({
          commandStore: 'sqlite',
          documentStore: 'in-memory',
          eventBus: 'redis-streams',
        }),
      ),
    )
    expect(streams).toContain('redis-streams')
    expect(streams).toContain('in-memory')
  })

  it('AC-1: a config with no media loads as local-fs, the same as one that names it', async () => {
    const implicit = await loadConfig(project(configWith(BASE)))
    const explicit = await loadConfig(project(configWith({ ...BASE, media: 'local-fs' })))

    expect(implicit.config.infrastructure.media).toBe('local-fs')
    expect(implicit.config.infrastructure).toEqual(explicit.config.infrastructure)
  })
})
