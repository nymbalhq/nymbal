import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import { ConfigError } from '@nymbalhq/types'
import { loadConfig } from './index.js'

// AC-2: documentStore, eventBus and media take the commerce block, `{ provider, package?, config? }`; a string there
// fails saying how to write the block. media defaults to `{ provider: 'local-fs' }`. The three cross-slot rules fail
// and pass as they did, reading `.provider`. `custom`, `package` beside a built-in, and `config` on a provider the
// kernel builds fail loadConfig. commandStore stays a string.

const BLOCK_SLOTS = ['documentStore', 'eventBus', 'media'] as const
type BlockSlot = (typeof BLOCK_SLOTS)[number]

const BUILT_IN: Record<BlockSlot, string> = {
  documentStore: 'in-memory',
  eventBus: 'in-process',
  media: 'local-fs',
}

/** The providers the kernel builds from its own connection blocks, and the block each one reads. */
const KERNEL_BUILT: ReadonlyArray<{ slot: BlockSlot; provider: string; block?: string }> = [
  { slot: 'documentStore', provider: 'in-memory' },
  { slot: 'eventBus', provider: 'in-process' },
  { slot: 'media', provider: 'local-fs' },
  { slot: 'documentStore', provider: 'redis', block: 'infrastructure.redis' },
  { slot: 'documentStore', provider: 'postgres-jsonb' },
  { slot: 'eventBus', provider: 'redis-streams', block: 'infrastructure.redis' },
  { slot: 'media', provider: 's3', block: 'infrastructure.s3' },
]

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Infrastructure = Record<string, unknown>

const BASE: Infrastructure = {
  commandStore: 'sqlite',
  documentStore: { provider: 'in-memory' },
  eventBus: { provider: 'in-process' },
}

function configWith(infrastructure: Infrastructure): Record<string, unknown> {
  return {
    store: { name: 'Test Store', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
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

/** `slot` set to `block`, with the companions the cross-slot rules require, so only the block is under test. */
function withSlot(slot: BlockSlot, block: Record<string, unknown>): Infrastructure {
  const infra: Infrastructure = { ...BASE, [slot]: block }
  const provider = block['provider']
  if (slot === 'documentStore' && provider === 'postgres-jsonb') infra['commandStore'] = 'postgres'
  if (slot === 'eventBus' && provider === 'redis-streams')
    infra['documentStore'] = { provider: 'redis' }
  return infra
}

function project(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'infrastructure-blocks-'))
  dirs.push(dir)
  writeFileSync(
    join(dir, 'nymbal.config.ts'),
    `export default ${JSON.stringify(config, null, 2)}\n`,
  )
  return dir
}

function rejectionOf(infrastructure: Infrastructure): Promise<unknown> {
  return loadConfig(project(configWith(infrastructure))).then(
    () => null,
    (error: unknown) => error,
  )
}

function messageOf(error: unknown): string {
  expect(error, 'loadConfig accepted it').toBeInstanceOf(ConfigError)
  return (error as ConfigError).message
}

async function loadedInfrastructure(
  infrastructure: Infrastructure,
): Promise<Record<string, unknown>> {
  const loaded = await loadConfig(project(configWith(infrastructure)))
  return loaded.config.infrastructure as unknown as Record<string, unknown>
}

const quoted = (message: string, value: string): boolean =>
  [`'${value}'`, `"${value}"`, `\`${value}\``].some((q) => message.includes(q))

const providerName = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,24}$/)

describe('AC-2: the infrastructure slots take a block', () => {
  it("AC-2: a string on documentStore, eventBus or media fails with `infrastructure.<slot> takes a block: write { provider: '<value>' }`", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...BLOCK_SLOTS), providerName, async (slot, value) => {
        const message = messageOf(await rejectionOf({ ...BASE, [slot]: value }))
        expect(message).toContain(
          `infrastructure.${slot} takes a block: write { provider: '${value}' }`,
        )
      }),
      { numRuns: 25 },
    )
  })

  it('AC-2: every slot keeps the block it is given: a built-in, each first-party provider, and a third party with package and config', async () => {
    const cells: Array<{ slot: BlockSlot; block: Record<string, unknown> }> = [
      ...KERNEL_BUILT.map(({ slot, provider }) => ({ slot, block: { provider } })),
      ...BLOCK_SLOTS.map((slot) => ({
        slot,
        block: {
          provider: 'acme',
          package: `@acme/nymbal-${slot.toLowerCase()}`,
          config: { region: 'eu', n: 2 },
        },
      })),
    ]
    for (const { slot, block } of cells) {
      const infra = await loadedInfrastructure(withSlot(slot, block))
      expect(infra[slot], `${slot}: ${JSON.stringify(block)}`).toEqual(block)
    }
  })

  it("AC-2: a config with no media loads as { provider: 'local-fs' }, the same as one that names it", async () => {
    const implicit = await loadedInfrastructure(BASE)
    const explicit = await loadedInfrastructure({ ...BASE, media: { provider: 'local-fs' } })

    expect(implicit['media']).toEqual({ provider: 'local-fs' })
    expect(implicit).toEqual(explicit)
  })

  it('AC-2: the cross-slot rules fail and pass as before, reading the provider, over every combination of providers and the s3 block', async () => {
    const pairs = fc.record({
      commandStore: fc.constantFrom('sqlite', 'postgres'),
      documentStore: fc.constantFrom('in-memory', 'redis', 'postgres-jsonb', 'acme'),
      eventBus: fc.constantFrom('in-process', 'redis-streams', 'acme'),
      media: fc.constantFrom('local-fs', 's3', 'acme'),
      s3: fc.boolean(),
    })
    await fc.assert(
      fc.asyncProperty(pairs, async (p) => {
        const jsonbOnSqlite = p.documentStore === 'postgres-jsonb' && p.commandStore !== 'postgres'
        const streamsOnMemory = p.eventBus === 'redis-streams' && p.documentStore === 'in-memory'
        const s3WithoutMedia = p.s3 && p.media !== 's3'
        const error = await rejectionOf({
          commandStore: p.commandStore,
          documentStore: { provider: p.documentStore },
          eventBus: { provider: p.eventBus },
          media: { provider: p.media },
          ...(p.s3 && { s3: { bucket: 'shop-media' } }),
        })
        const label = `${JSON.stringify(p)}: ${String((error as Error | null)?.message)}`

        expect(error === null, label).toBe(!jsonbOnSqlite && !streamsOnMemory && !s3WithoutMedia)
        const message = error === null ? '' : messageOf(error)
        // What each rule that fires must say: the values it compares, read from the blocks.
        const said = [
          ...(jsonbOnSqlite
            ? [message.includes('postgres-jsonb'), /\bcommandStore\b/.test(message)]
            : []),
          ...(streamsOnMemory
            ? [message.includes('redis-streams'), message.includes('in-memory')]
            : []),
          ...(s3WithoutMedia ? [quoted(message, p.media)] : []),
        ]
        expect(
          said.filter((ok) => !ok),
          message,
        ).toEqual([])
        expect(message, label).not.toContain('[object Object]')
      }),
      { numRuns: 40 },
    )
  })
})

describe('AC-2: what an infrastructure block cannot hold', () => {
  it("AC-2: provider 'custom' on documentStore, eventBus or media fails loadConfig naming package:", async () => {
    for (const slot of BLOCK_SLOTS) {
      for (const block of [
        { provider: 'custom' },
        { provider: 'custom', package: '@acme/nymbal-x' },
      ]) {
        const message = messageOf(await rejectionOf(withSlot(slot, block)))
        expect(message, slot).toMatch(new RegExp(`\\b${slot}\\b`))
        expect(message, slot).toContain('package:')
      }
    }
  })

  it('AC-2: package beside a built-in fails naming both; the same block without package loads', async () => {
    for (const slot of BLOCK_SLOTS) {
      const provider = BUILT_IN[slot]
      const message = messageOf(
        await rejectionOf(withSlot(slot, { provider, package: '@acme/nymbal-builtin' })),
      )
      expect(quoted(message, provider), `${slot}: ${message}`).toBe(true)
      expect(message, slot).toMatch(/\bpackage\b/)
      expect(await rejectionOf(withSlot(slot, { provider })), slot).toBeNull()
    }
  })

  it('AC-2: config on a provider the kernel builds fails loadConfig, naming the connection block that configures it; a third party takes config', async () => {
    for (const { slot, provider, block } of KERNEL_BUILT) {
      const message = messageOf(
        await rejectionOf(withSlot(slot, { provider, config: { url: 'x' } })),
      )
      expect(message, `${slot} ${provider}`).toMatch(new RegExp(`\\b${slot}\\b`))
      expect(quoted(message, provider), `${slot} ${provider}: ${message}`).toBe(true)
      expect(message, `${slot} ${provider}`).toMatch(/\bconfig\b/)
      expect(
        message.includes(block ?? 'config'),
        `${slot} ${provider} names ${block}: ${message}`,
      ).toBe(true)
      expect(await rejectionOf(withSlot(slot, { provider })), `${slot} ${provider}`).toBeNull()
    }
    expect(
      await rejectionOf(withSlot('media', { provider: 'acme', config: { url: 'x' } })),
    ).toBeNull()
  })

  it('AC-2: commandStore stays a string: each dialect loads as itself beside block-form slots, and a block there fails', async () => {
    for (const commandStore of ['sqlite', 'postgres']) {
      const infra = await loadedInfrastructure({ ...BASE, commandStore })
      expect(infra['commandStore']).toBe(commandStore)
    }
    const message = messageOf(await rejectionOf({ ...BASE, commandStore: { provider: 'sqlite' } }))
    expect(message).toMatch(/\bcommandStore\b/)
  })
})
