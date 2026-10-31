import { describe, expect, it } from 'vitest'
import { ADAPTER_CATALOGUE, slotFolder } from '@nymbalhq/config'
import { ConfigError, type Slot } from '@nymbalhq/types'
import { importAdapterModule } from './resolve.js'

// AC-4: an adapter error shows a slot by its folder name where it only names the slot (`unknown document-store
// provider`), and keeps the config key where the developer types it: a `nymbal.config.ts` path
// (`infrastructure.documentStore 'redis'`) or an adapter's `slot` export value (`slot = 'documentStore'`).
// Through the importer seam: a stub importer answers with a module or throws Node's not-installed error.

const SLOTS = Object.keys(ADAPTER_CATALOGUE) as Slot[]
const PNPM: NodeJS.ProcessEnv = { npm_config_user_agent: 'pnpm/9.15.4 npm/? node/v22 darwin arm64' }

function notInstalled(specifier: string): Error {
  return Object.assign(
    new Error(`Cannot find package '${specifier}' imported from /srv/store/node_modules/x.js`),
    { code: 'ERR_MODULE_NOT_FOUND' },
  )
}

const importer =
  (installed: Record<string, unknown> = {}) =>
  async (specifier: string): Promise<unknown> => {
    if (Object.hasOwn(installed, specifier)) return installed[specifier]
    throw notInstalled(specifier)
  }

async function rejection(promise: Promise<unknown>): Promise<ConfigError> {
  const error = await promise.then(
    () => new Error('resolved'),
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(ConfigError)
  return error as ConfigError
}

describe('AC-4: adapter errors name a slot by folder, a config path or export value by its key', () => {
  it("AC-4: on documentStore, a missing catalogue package still names infrastructure.documentStore 'redis', a wrong slot export keeps 'documentStore' slot and slot = 'documentStore', and an unknown provider is `unknown document-store provider 'x'`", async () => {
    const missing = await rejection(
      importAdapterModule('documentStore', { provider: 'redis' }, PNPM, importer()),
    )
    expect(missing.code).toBe('adapter.package_missing')
    expect(missing.message).toContain("infrastructure.documentStore 'redis' needs")

    const PKG = '@acme/nymbal-store'
    const wrongSlot = await rejection(
      importAdapterModule(
        'documentStore',
        { provider: 'acme', package: PKG },
        PNPM,
        importer({ [PKG]: { slot: 'eventBus', provider: 'acme', createAdapter: () => ({}) } }),
      ),
    )
    expect(wrongSlot.code).toBe('adapter.wrong_slot')
    expect(wrongSlot.message).toBe(
      `${PKG} is loaded for the 'documentStore' slot, but its slot export is 'eventBus': it must export slot = 'documentStore'`,
    )

    const unknown = await rejection(
      importAdapterModule('documentStore', { provider: 'x' }, PNPM, importer()),
    )
    expect(unknown.code).toBe('adapter.provider_unknown')
    expect(unknown.message).toContain("unknown document-store provider 'x'")
  })

  it('AC-4: on every slot but security, an unknown provider names the slot by its folder name, and no slot by its camelCase key', async () => {
    for (const slot of SLOTS.filter((s) => s !== 'security')) {
      const error = await rejection(
        importAdapterModule(slot, { provider: 'zzqx-unheard' }, PNPM, importer()),
      )

      expect(error.code, error.message).toBe('adapter.provider_unknown')
      expect(error.message).toContain(`unknown ${slotFolder(slot)} provider 'zzqx-unheard'`)
      expect(error.message.match(/\b(documentStore|eventBus)\b/g) ?? [], error.message).toEqual([])
    }
  })
})
