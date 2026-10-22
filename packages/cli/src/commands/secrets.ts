import { defineCommand } from 'citty'
import pc from 'picocolors'
import {
  createCommandStore,
  createSettingsRepository,
  decrypt,
  encrypt,
  isMissingSettingsTable,
  keyProblem,
  readSecretsKey,
  SECRETS_KEY_ENV,
  SECRETS_KEY_OLD_ENV,
  settingAad,
  type SettingRow,
} from '@nymbalhq/platform'
import { loadProject } from '../utils/project.js'

/** Rotation's refusal: exit 2, and nothing written. */
class RotationRefused extends Error {}

function refuse(message: string): void {
  process.stderr.write(`${pc.red(`✗ ${message}`)}\n`)
  process.exitCode = 2
}

/**
 * Every encrypted row decrypted under OLD and encrypted again under NEW, in one transaction. A row that is not OLD's,
 * or does not decrypt under it, refuses the rotation before anything is written. Values never reach the output.
 */
export async function rotateSecrets(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const oldKey = readSecretsKey(env, SECRETS_KEY_OLD_ENV)
  if (!oldKey.ok) throw new RotationRefused(keyProblem(oldKey.reason, SECRETS_KEY_OLD_ENV))
  const newKey = readSecretsKey(env, SECRETS_KEY_ENV)
  if (!newKey.ok) throw new RotationRefused(keyProblem(newKey.reason, SECRETS_KEY_ENV))
  const { config } = await loadProject()
  const store = createCommandStore(config)
  try {
    const repo = createSettingsRepository(store)
    return await store.transaction(async (tx) => {
      const rows = await repo.list(tx)
      const rotated: SettingRow[] = []
      for (const row of rows) {
        if (row.ciphertext === null) continue
        const field = `${row.slot}.${row.path}`
        if (row.keyId !== oldKey.id) {
          throw new RotationRefused(
            `${field} is under key ${row.keyId ?? '(none)'}, not ${SECRETS_KEY_OLD_ENV} (key ${oldKey.id}); nothing was rotated`,
          )
        }
        let value: string
        try {
          value = decrypt(oldKey.key, settingAad(row.slot, row.path), row)
        } catch {
          throw new RotationRefused(
            `${field} does not decrypt under ${SECRETS_KEY_OLD_ENV}; nothing was rotated`,
          )
        }
        const sealed = encrypt(newKey.key, settingAad(row.slot, row.path), value)
        rotated.push({ ...row, ...sealed, keyId: newKey.id, updatedAt: new Date() })
      }
      for (const row of rotated) await repo.put(tx, row)
      return rotated.length
    })
  } finally {
    await store.close()
  }
}

/** Deletes rows, every one or those of a slot or path, without the key: the recovery for a lost one. */
export async function clearSecrets(filter: { slot?: string; path?: string }): Promise<number> {
  const { config } = await loadProject()
  const store = createCommandStore(config)
  try {
    const repo = createSettingsRepository(store)
    return await store.transaction((tx) => repo.clear(tx, filter))
  } catch (error) {
    if (isMissingSettingsTable(error)) return 0
    throw error
  } finally {
    await store.close()
  }
}

const rotateCommand = defineCommand({
  meta: {
    name: 'rotate',
    description: `Re-encrypt every saved secret from ${SECRETS_KEY_OLD_ENV} to ${SECRETS_KEY_ENV}, all or none`,
  },
  async run() {
    try {
      const count = await rotateSecrets()
      process.stdout.write(
        `${pc.green(`✓ rotated ${count} secret${count === 1 ? '' : 's'} to ${SECRETS_KEY_ENV}`)}\n`,
      )
    } catch (error) {
      // Any failure leaves every row as it was (one transaction), and rotation answers 2 for all of them.
      refuse(error instanceof Error ? error.message : String(error))
    }
  },
})

const clearCommand = defineCommand({
  meta: {
    name: 'clear',
    description: 'Delete saved settings (all, or one slot or path); needs no key',
  },
  args: {
    slot: { type: 'string', description: 'Only this slot' },
    path: { type: 'string', description: 'Only this path' },
  },
  async run({ args }) {
    const count = await clearSecrets({
      ...(args.slot !== undefined && { slot: args.slot }),
      ...(args.path !== undefined && { path: args.path }),
    })
    process.stdout.write(
      `${pc.green(`✓ cleared ${count} setting${count === 1 ? '' : 's'}`)}; restart the store to apply\n`,
    )
  },
})

export const secretsCommand = defineCommand({
  meta: { name: 'secrets', description: "Manage the values saved in the admin's Settings" },
  subCommands: { rotate: rotateCommand, clear: clearCommand },
})
