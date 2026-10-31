import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ADAPTER_CATALOGUE, nymbalConfigSchema, slotFolder } from '@nymbalhq/config'
import type { Slot } from '@nymbalhq/types'
import { diagnose } from '../../src/index.js'
import { createLogger } from '../../src/logger.js'
import { kernelConfig } from '../support/kernel.js'

// AC-1: doctor names every slot as its folder does (`document-store`), never by its config key. One diagnose run over
// a config whose every slot names a provider no package holds ('acme'), so each slot resolves to a package and gets a
// `package <slot>` check, each down without any network. The command store is a SQLite path that does not exist.

const logger = createLogger({ pretty: false, level: 'silent' })
const SLOTS = Object.keys(ADAPTER_CATALOGUE) as Slot[]
const PRIMITIVES: readonly Slot[] = ['documentStore', 'eventBus', 'media']
const CAMEL_KEYS = SLOTS.filter((slot) => slotFolder(slot) !== slot)

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'nymbal-doctor-slot-names-'))
})
afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

/** The kernel config with every commerce slot, every primitive and security on the provider 'acme'. */
function everySlotOnAPackage() {
  const base = kernelConfig('sqlite')
  const commerce = Object.fromEntries(
    Object.keys(base.commerce)
      .filter((name) => name !== 'orders')
      .map((name) => [name, { provider: 'acme' }]),
  )
  return nymbalConfigSchema.parse({
    ...base,
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'acme' },
      eventBus: { provider: 'acme' },
      media: { provider: 'acme' },
    },
    security: { ...base.security, adapter: 'acme' },
    commerce: { ...base.commerce, ...commerce },
  })
}

describe('AC-1: doctor names slots in kebab case', () => {
  it('AC-1: one diagnose run gives `package <name>` for every slot as its folder name, and `primitive <name>` for each primitive as its folder name, with no camelCase key in any check name', async () => {
    const report = await diagnose(everySlotOnAPackage(), {
      logger,
      timeoutMs: 5000,
      sqlitePath: join(dir, 'absent.sqlite'),
      env: {},
    })
    const names = report.checks.map((c) => c.name)
    const named = (prefix: string) =>
      names
        .filter((n) => n.startsWith(prefix))
        .map((n) => n.slice(prefix.length))
        .sort()

    expect(
      report.checks.find((c) => c.name === 'config')?.status,
      JSON.stringify(report.checks),
    ).toBe('ok')
    expect(named('package ')).toEqual(SLOTS.map(slotFolder).sort())
    expect(named('primitive ')).toEqual(PRIMITIVES.map(slotFolder).sort())
    expect(
      names.filter((n) => CAMEL_KEYS.some((key) => n.split(' ').includes(key))),
      'check names that spell a slot by its config key',
    ).toEqual([])
  })
})
