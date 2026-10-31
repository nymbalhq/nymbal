import type { NymbalConfig } from '@nymbalhq/config'
import { ConfigError, type AdapterSetting, type CommerceSlot, type Logger } from '@nymbalhq/types'
import { declaredSettings, importAdapterModule } from '../adapters/resolve.js'
import { COMMERCE_SLOTS } from '../adapters/registry.js'
import {
  createCommandStore,
  type CommandStore,
  type CommandStoreOptions,
} from '../db/command-store.js'
import { createSettingsRepository, type SettingRow } from '../repositories/settings.js'
import { decrypt, keyProblem, readSecretsKey, settingAad, type SecretsKey } from './crypto.js'
import { sourceOf, type SettingValue } from './resolve.js'
import { addSecret } from './secret-set.js'

/** A slot whose provider package declares settings. */
export interface DeclaredSlot {
  slot: CommerceSlot
  provider: string
  declared: readonly AdapterSetting[]
}

/** Each commerce slot whose provider package declares settings, imported as `resolveSlot` imports it. */
export async function declaredSlots(
  config: NymbalConfig,
  env: NodeJS.ProcessEnv,
): Promise<DeclaredSlot[]> {
  const out: DeclaredSlot[] = []
  for (const slot of COMMERCE_SLOTS) {
    const block = config.commerce[slot]
    const provider = block.provider
    if (provider === 'custom') continue
    const declared = declaredSettings(await importAdapterModule(slot, block, env))
    if (declared.length > 0) out.push({ slot, provider, declared })
  }
  return out
}

/** A store from before migration 0008 has no `settings` relation: it holds no settings. */
export function isMissingSettingsTable(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null
  if (e?.code === '42P01') return true
  return typeof e?.message === 'string' && /no such table: settings\b/.test(e.message)
}

/** Every row of `settings` through `store`, or none when the store predates the table. */
export async function listStoredSettings(store: CommandStore): Promise<SettingRow[]> {
  const repo = createSettingsRepository(store)
  try {
    return await store.read((tx) => repo.list(tx))
  } catch (error) {
    if (isMissingSettingsTable(error)) return []
    throw error
  }
}

/**
 * The rows of `settings` through a read-only open of the command store, closed before this returns. A SQLite file that
 * does not exist yet (a fresh scaffold) holds none, like a store without the table.
 */
export async function readStoredSettings(
  config: NymbalConfig,
  storage: Pick<CommandStoreOptions, 'sqlitePath' | 'postgresUrl'>,
): Promise<SettingRow[]> {
  let store: CommandStore
  try {
    store = createCommandStore(config, { ...storage, readOnly: true })
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'SQLITE_CANTOPEN') return []
    throw error
  }
  try {
    return await listStoredSettings(store)
  } finally {
    await store.close()
  }
}

/**
 * The values the rows give the fields the config and the environment leave unset, decrypted under
 * `NYMBAL_SECRETS_KEY`; each joins the process's secret set. A row that config or env shadows is not read, only
 * warned of. A row the fill would use refuses with a `ConfigError` naming slot and path when the key is unset or
 * malformed, is another key, or the row does not decrypt.
 */
export function settingValues(
  config: NymbalConfig,
  slots: readonly DeclaredSlot[],
  rows: readonly SettingRow[],
  env: NodeJS.ProcessEnv,
  logger: Logger,
): SettingValue[] {
  const values: SettingValue[] = []
  let key: SecretsKey | undefined
  for (const { slot, declared } of slots) {
    const block = config.commerce[slot].config ?? {}
    for (const decl of declared) {
      const row = rows.find((r) => r.slot === slot && r.path === decl.path)
      if (row === undefined) continue
      const { path } = decl
      const source = sourceOf(block, decl, env, true)
      if (source !== 'settings') {
        logger.warn(
          { slot, path, source },
          `settings: ${slot}.${path} is set by ${source === 'env' ? `${decl.env}` : 'the config'}; its saved value is not used`,
        )
        continue
      }
      if (row.plain !== null) {
        values.push({ slot, path, value: row.plain })
        continue
      }
      key ??= readSecretsKey(env)
      const value = decryptRow(key, slot, path, row)
      addSecret(value)
      values.push({ slot, path, value })
    }
  }
  return values
}

function decryptRow(key: SecretsKey, slot: string, path: string, row: SettingRow): string {
  const field = `${slot}.${path}`
  const context = { slot, path }
  if (!key.ok) {
    throw new ConfigError(
      `Settings hold ${field} encrypted, but ${keyProblem(key.reason)}. Set it to the key the value was saved ` +
        `under, or remove the value with \`nymbal secrets clear --slot ${slot} --path ${path}\`.`,
      { code: 'config.secrets_key', context },
    )
  }
  if (row.keyId !== key.id) {
    throw new ConfigError(
      `Settings hold ${field} under key ${row.keyId ?? '(none)'}, but NYMBAL_SECRETS_KEY is key ${key.id}. ` +
        'Set the key it was saved under, or rotate with `nymbal secrets rotate`.',
      { code: 'config.secrets_key', context },
    )
  }
  try {
    return decrypt(key.key, settingAad(slot, path), row)
  } catch (cause) {
    throw new ConfigError(
      `Settings hold ${field}, but it does not decrypt under NYMBAL_SECRETS_KEY: the row was changed or moved.`,
      { code: 'config.secrets_tampered', context, cause },
    )
  }
}

export interface BootSettings {
  slots: DeclaredSlot[]
  values: SettingValue[]
}

/**
 * What `createApp` and `diagnose` read before any adapter is built: the slots that declare settings and the values
 * Settings give them. A store whose providers declare nothing is not opened.
 */
export async function loadBootSettings(
  config: NymbalConfig,
  opts: {
    storage: Pick<CommandStoreOptions, 'sqlitePath' | 'postgresUrl'>
    env: NodeJS.ProcessEnv
    logger: Logger
  },
): Promise<BootSettings> {
  const slots = await declaredSlots(config, opts.env)
  if (slots.length === 0) return { slots, values: [] }
  const rows = await readStoredSettings(config, opts.storage)
  return { slots, values: settingValues(config, slots, rows, opts.env, opts.logger) }
}
