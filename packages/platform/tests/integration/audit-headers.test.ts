import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  adminSession,
  auditRows,
  IDEMPOTENCY_KEY,
  KEY_PATTERN,
  type AdminSession,
} from '../support/audit.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, seedVariant, type Seeded } from '../support/kernel.js'
import { openRaw, stockOf, type RawReader } from '../support/raw.js'

// AC-7, the request half, on SQLite: an admin write with an Idempotency-Key outside 1-128 characters of
// [A-Za-z0-9._:-] answers 400 naming the header before anything moves; a well-formed one is stored. The CORS half is
// packages/http/src/cors-expose-headers.test.ts.

let served: ServedKernel
let raw: RawReader
let admin: AdminSession
let seeded: Seeded

beforeAll(async () => {
  const kernel = await createKernel({ dialect: 'sqlite' })
  served = await serveKernel(kernel)
  raw = openRaw('sqlite', kernel.target)
  admin = await adminSession(kernel, served.baseUrl)
  seeded = await seedVariant(kernel, 100_000)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await served?.stop()
})

/** The value the store sees for a header sent as `sent`: HTTP drops leading and trailing spaces and tabs. */
function asReceived(sent: string): string {
  return sent.replace(/^[ \t]+|[ \t]+$/g, '')
}

describe('AC-7: a malformed Idempotency-Key is refused', () => {
  const latin1 = fc
    .integer({ min: 0x20, max: 0xff })
    .filter((c) => c !== 0x7f)
    .map((c) => String.fromCharCode(c))
  const malformed = fc
    .oneof(
      fc.string({ unit: latin1, maxLength: 140 }),
      fc.string({
        unit: fc.constantFrom('a', '9', '.', ':', '-', '_'),
        minLength: 129,
        maxLength: 200,
      }),
      fc.constantFrom('', 'has space', '<script>', 'key/slash', 'café', 'a'.repeat(129)),
    )
    .filter((key) => !KEY_PATTERN.test(asReceived(key)))

  const adjust = (key: string) =>
    admin.send(
      'POST',
      `/api/admin/inventory/${seeded.variantId}/adjust`,
      { delta: 1, reason: 'manual' },
      { [IDEMPOTENCY_KEY]: key },
    )

  it('AC-7: property (60 runs): a key that is not 1-128 of [A-Za-z0-9._:-] answers 400 naming Idempotency-Key, moves no stock and is stored nowhere', async () => {
    await fc.assert(
      fc.asyncProperty(malformed, async (key) => {
        const before = await stockOf(raw, seeded.variantId)
        const res = await adjust(key)
        const context = `sent ${JSON.stringify(key)}: ${res.status} ${JSON.stringify(res.body)}`

        expect(res.status, context).toBe(400)
        expect(/idempotency-key/i.test(JSON.stringify(res.body.error ?? {})), context).toBe(true)
        expect(await stockOf(raw, seeded.variantId), context).toBe(before)
        expect(await auditRows(raw, 'idempotency_key = ?', [asReceived(key)]), context).toEqual([])
      }),
      { numRuns: 60, endOnFailure: true },
    )
  }, 120_000)

  it('AC-7: property (20 runs): a well-formed key, up to 128 characters, applies the write and is stored on its applied entry', async () => {
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[A-Za-z0-9._:-]{0,92}$/), async (tail) => {
        const key = `${randomUUID()}${tail}`
        const before = await stockOf(raw, seeded.variantId)
        const res = await adjust(key)
        const context = `sent ${JSON.stringify(key)}: ${res.status} ${JSON.stringify(res.body)}`

        expect(res.status, context).toBe(200)
        expect(await stockOf(raw, seeded.variantId), context).toBe(before + 1)
        expect(
          (await auditRows(raw, 'idempotency_key = ?', [key])).map((r) => r.outcome),
          context,
        ).toEqual(['applied'])
      }),
      { numRuns: 20, endOnFailure: true },
    )
  }, 60_000)
})
