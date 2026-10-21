import { createHash } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { COMMERCE_SLOTS } from '../adapters/registry.js'
import { bytesOf, flipByte } from '../../tests/support/bytes.js'
import { decrypt, encrypt, keyId } from './crypto.js'

// P3-07 AC-1 (spec P3-07-secrets-settings, Decision 3): AES-256-GCM per value with a fresh 12-byte IV and the AAD
// "<slot>:<path>". Over generated keys, slots, dot paths and values (multi-byte included): a value decrypts back to
// itself; two encryptions of one value differ; a ciphertext read under another slot, another path or another key
// throws; one flipped byte in the ciphertext, the IV or the tag throws. `encrypt` returns the row's binary columns
// ({ ciphertext, iv, tag }) in whatever representation the store keeps; `decrypt` takes that row back.
// Kills: a static IV, no AAD (a row moved to another field still decrypts), tampering left undetected.

const keyArb = fc.uint8Array({ minLength: 32, maxLength: 32 }).map((bytes) => Buffer.from(bytes))
const slotArb = fc.constantFrom(...COMMERCE_SLOTS)
const pathArb = fc
  .array(fc.stringMatching(/^[a-z][A-Za-z0-9]{0,11}$/), { minLength: 1, maxLength: 3 })
  .map((parts) => parts.join('.'))
const valueArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 120 }),
  fc.string({ unit: 'grapheme', minLength: 1, maxLength: 40 }),
)

const aad = (slot: string, path: string): string => `${slot}:${path}`

type Row = ReturnType<typeof encrypt>
const FIELDS = ['ciphertext', 'iv', 'tag'] as const

describe('P3-07 AC-1: encryption round trip and binding', () => {
  it('AC-1: decrypt(encrypt(v)) is v for every key, slot, path and value', () => {
    fc.assert(
      fc.property(keyArb, slotArb, pathArb, valueArb, (key, slot, path, value) => {
        const row = encrypt(key, aad(slot, path), value)
        expect(decrypt(key, aad(slot, path), row)).toBe(value)
      }),
      { numRuns: 300 },
    )
  })

  it('AC-1: two encryptions of one value differ, each with a 12-byte IV of its own', () => {
    fc.assert(
      fc.property(keyArb, slotArb, pathArb, valueArb, (key, slot, path, value) => {
        const a = encrypt(key, aad(slot, path), value)
        const b = encrypt(key, aad(slot, path), value)
        expect(bytesOf(a.iv).length).toBe(12)
        expect(bytesOf(b.iv).length).toBe(12)
        expect(bytesOf(a.iv).equals(bytesOf(b.iv))).toBe(false)
        expect(bytesOf(a.ciphertext).equals(bytesOf(b.ciphertext))).toBe(false)
      }),
      { numRuns: 200 },
    )
  })

  it('AC-1: a ciphertext decrypted under another slot or another path throws', () => {
    fc.assert(
      fc.property(
        keyArb,
        slotArb,
        slotArb,
        pathArb,
        pathArb,
        valueArb,
        (key, slot, otherSlot, path, otherPath, value) => {
          fc.pre(slot !== otherSlot || path !== otherPath)
          const row = encrypt(key, aad(slot, path), value)
          expect(() => decrypt(key, aad(otherSlot, otherPath), row)).toThrow()
        },
      ),
      { numRuns: 300 },
    )
  })

  it('AC-1: a ciphertext decrypted under another key throws', () => {
    fc.assert(
      fc.property(
        keyArb,
        keyArb,
        slotArb,
        pathArb,
        valueArb,
        (key, otherKey, slot, path, value) => {
          fc.pre(!key.equals(otherKey))
          const row = encrypt(key, aad(slot, path), value)
          expect(() => decrypt(otherKey, aad(slot, path), row)).toThrow()
        },
      ),
      { numRuns: 200 },
    )
  })

  it('AC-1: one flipped byte in the ciphertext, the IV or the tag throws', () => {
    fc.assert(
      fc.property(
        keyArb,
        slotArb,
        pathArb,
        valueArb,
        fc.constantFrom(...FIELDS),
        fc.nat(),
        (key, slot, path, value, field, index) => {
          const row = encrypt(key, aad(slot, path), value)
          const tampered = { ...row, [field]: flipByte(row[field], index) } as Row
          expect(bytesOf(tampered[field]).equals(bytesOf(row[field]))).toBe(false)
          expect(() => decrypt(key, aad(slot, path), tampered)).toThrow()
        },
      ),
      { numRuns: 300 },
    )
  })

  it("AC-1 (Decision 3): keyId is the first 8 hex characters of the key's SHA-256", () => {
    fc.assert(
      fc.property(keyArb, (key) => {
        expect(keyId(key)).toBe(createHash('sha256').update(key).digest('hex').slice(0, 8))
      }),
      { numRuns: 100 },
    )
  })
})
