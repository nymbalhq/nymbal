import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ADAPTER_CATALOGUE, KNOWN_PROVIDERS, slotFolder, type Slot } from '@nymbalhq/config'
import repoConfig from '../../../../nymbal.config.js'
import { pickSlot } from './test-contracts.js'

// AC-5: `test:contracts --slot` reads a slot in either spelling, and names slots by their folder names when it asks
// for one. Each case is a project of its own whose config names the package on the slots under test.

const SLOTS = Object.keys(ADAPTER_CATALOGUE) as Slot[]
const PKG = '@acme/nymbal-adapter'
const ON_PKG = { provider: 'acme', package: PKG }
const isCommerce = (slot: Slot) => Object.hasOwn(KNOWN_PROVIDERS, slot)

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'nymbal-contracts-slot-'))
})
afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

/** A project whose config names PKG on each of `slots`, every other slot on its built-in. */
function projectNaming(slots: readonly Slot[]): string {
  const project = join(dir, slots.join('+'))
  mkdirSync(project, { recursive: true })
  const on = (slot: Slot) => slots.includes(slot)
  const raw = {
    ...repoConfig,
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: on('documentStore') ? ON_PKG : { provider: 'in-memory' },
      eventBus: on('eventBus') ? ON_PKG : { provider: 'in-process' },
      media: on('media') ? ON_PKG : { provider: 'local-fs' },
    },
    security: on('security')
      ? { ...repoConfig.security, adapter: 'acme', package: PKG }
      : { ...repoConfig.security, adapter: 'middleware' },
    commerce: {
      ...repoConfig.commerce,
      ...Object.fromEntries(slots.filter(isCommerce).map((slot) => [slot, ON_PKG])),
    },
  }
  writeFileSync(
    join(project, 'nymbal.config.ts'),
    `export default ${JSON.stringify(raw, null, 2)}\n`,
  )
  return project
}

describe('AC-5: test:contracts --slot takes either spelling', () => {
  it('AC-5: for a package on any slot, --slot <folder name> picks the same slot and block as --slot <config key>, and that slot is the key', async () => {
    for (const slot of SLOTS) {
      const project = projectNaming([slot])
      const byKey = await pickSlot(project, PKG, slot)

      expect(byKey?.slot).toBe(slot)
      expect(await pickSlot(project, PKG, slotFolder(slot)), `--slot ${slotFolder(slot)}`).toEqual(
        await pickSlot(project, PKG, slot),
      )
    }
  })

  it("AC-5: --slot nope is refused with no slot 'nope' loads <pkg>", async () => {
    const project = projectNaming(['documentStore'])

    await expect(pickSlot(project, PKG, 'nope')).rejects.toThrow(`no slot 'nope' loads ${PKG}`)
  })

  it('AC-5: a package named by the documentStore and eventBus slots is told it is named by the document-store, event-bus slots', async () => {
    const project = projectNaming(['documentStore', 'eventBus'])

    await expect(pickSlot(project, PKG, undefined)).rejects.toThrow(
      `${PKG} is named by the document-store, event-bus slots: pick one with --slot`,
    )
  })
})
