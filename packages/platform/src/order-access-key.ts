import { createHash, randomBytes } from 'node:crypto'

/** 32 random bytes as base64url, unpadded. */
const ORDER_KEY = /^[A-Za-z0-9_-]{43}$/

/**
 * A fresh key that opens one order, and the hash that is all the store keeps of it. At 256 bits of entropy a plain
 * SHA-256 is enough: no salt, no slow hash.
 */
export function mintOrderKey(): { key: string; hash: string } {
  const key = randomBytes(32).toString('base64url')
  return { key, hash: hashOrderKey(key) }
}

export function hashOrderKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export function isOrderKey(value: unknown): value is string {
  return typeof value === 'string' && ORDER_KEY.test(value)
}
