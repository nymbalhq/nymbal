import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/** The binary columns of an encrypted settings row. */
export interface EncryptedValue {
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
}

/** The same columns as a driver hands them back (a Buffer, or a Uint8Array). */
export interface StoredCipher {
  ciphertext: Uint8Array | null
  iv: Uint8Array | null
  tag: Uint8Array | null
}

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16
export const KEY_BYTES = 32

/** The environment variable holding the master key, and the one `nymbal secrets rotate` reads the old key from. */
export const SECRETS_KEY_ENV = 'NYMBAL_SECRETS_KEY'
export const SECRETS_KEY_OLD_ENV = 'NYMBAL_SECRETS_KEY_OLD'

/** AES-256-GCM under a fresh IV, bound to `aad` (`<slot>:<path>`), so a row moved to another field fails to decrypt. */
export function encrypt(key: Buffer, aad: string, plaintext: string): EncryptedValue {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return { ciphertext, iv, tag: cipher.getAuthTag() }
}

/** The plaintext, or a throw when the key, the AAD or any byte of the row is not what encrypted it. */
export function decrypt(key: Buffer, aad: string, row: StoredCipher): string {
  if (row.ciphertext === null || row.iv === null || row.tag === null) {
    throw new Error('not an encrypted row')
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(row.iv), {
    authTagLength: TAG_BYTES,
  })
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(Buffer.from(row.tag))
  return Buffer.concat([decipher.update(Buffer.from(row.ciphertext)), decipher.final()]).toString(
    'utf8',
  )
}

/** The first 8 hex characters of the key's SHA-256: which key a row was written under, without the key. */
export function keyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8)
}

export type SecretsKey =
  | { ok: true; key: Buffer; id: string }
  | { ok: false; reason: 'missing' | 'malformed' }

const BASE64_32 = /^[A-Za-z0-9+/]{43}=?$/

/** The master key in `env[name]`: 32 bytes as base64, else why it cannot be used. */
export function readSecretsKey(env: NodeJS.ProcessEnv, name = SECRETS_KEY_ENV): SecretsKey {
  const value = env[name]?.trim()
  if (value === undefined || value === '') return { ok: false, reason: 'missing' }
  if (!BASE64_32.test(value)) return { ok: false, reason: 'malformed' }
  const key = Buffer.from(value, 'base64')
  if (key.length !== KEY_BYTES) return { ok: false, reason: 'malformed' }
  return { ok: true, key, id: keyId(key) }
}

/** What to tell an operator about a key `readSecretsKey` refused, naming the variable and never its value. */
export function keyProblem(reason: 'missing' | 'malformed', name = SECRETS_KEY_ENV): string {
  return reason === 'missing' ? `${name} is not set` : `${name} is not 32 bytes of base64`
}

/** The AAD of a settings row. */
export function settingAad(slot: string, path: string): string {
  return `${slot}:${path}`
}
