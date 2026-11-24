import { readFileSync } from 'node:fs'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { CartCodeStatus, PromotionEffect } from '@nymbalhq/types'
import { validateAcp } from '../../../../../tests/fixtures/acp/validate.js'
import { acpDiscounts, discountErrorCode } from './session.js'

// The `discounts` block an ACP session answers, built from the cart's codes and the money effects its totals applied,
// against the pinned 2026-04-17 schema: what an agent is told was applied and refused, and why.

const SCHEMA = JSON.parse(
  readFileSync(
    new URL(
      '../../../../../tests/fixtures/acp/2026-04-17/schema.agentic_checkout.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { $defs: { DiscountErrorCode: { enum: string[] } } }

/** Every reason code the pinned protocol has. */
const DISCOUNT_ERROR_CODES = SCHEMA.$defs.DiscountErrorCode.enum
const APPLIED_DISCOUNT = 'schema.agentic_checkout.json#/$defs/AppliedDiscount'

/** The engine reasons with a protocol code of their own; any other is `discount_code_invalid`. */
const MAPPED: Record<string, string> = {
  expired: 'discount_code_expired',
  below_minimum: 'discount_code_minimum_not_met',
  cap_reached: 'discount_code_usage_limit_reached',
  one_code_per_order: 'discount_code_combination_disallowed',
}

/** What the storefront says of a refused code; the ACP warning's text is the same. */
const MESSAGES: Record<string, string> = {
  expired: 'This code has expired.',
  below_minimum: "Your order is below this code's minimum spend.",
  cap_reached: 'This code has been fully used.',
  wrong_currency: "This code can't be used in this currency.",
  one_code_per_order: 'Only one code can be used per order.',
  free_order_unsupported: "This code can't be used on this order.",
}
const NOT_VALID = "This code isn't valid."

const mappedOf = (reason: string): string =>
  Object.hasOwn(MAPPED, reason) ? MAPPED[reason]! : 'discount_code_invalid'
const messageOf = (reason: string): string =>
  Object.hasOwn(MESSAGES, reason) ? MESSAGES[reason]! : NOT_VALID

/** The reasons the native engine and the cart give, then anything another engine might send. */
const NATIVE_REASONS = [
  'expired',
  'below_minimum',
  'cap_reached',
  'wrong_currency',
  'one_code_per_order',
  'free_order_unsupported',
  'unknown',
  'inactive',
  'unanswered',
]
const reason = fc.oneof(
  fc.constantFrom(...NATIVE_REASONS),
  fc.string({ maxLength: 24 }),
  fc.constantFrom('constructor', '__proto__', 'toString', 'EXPIRED', ' expired'),
)

const codeText = fc.stringMatching(/^[A-Za-z0-9-]{1,12}$/)

/** A cart's codes, distinct whatever their case, each with what the engine said of it. */
const cartCodes: fc.Arbitrary<CartCodeStatus[]> = fc
  .uniqueArray(
    fc.record({
      code: codeText,
      verdict: fc.oneof(
        fc.constant<{ status: 'accepted' }>({ status: 'accepted' }),
        fc.constant<{ status: 'pending' }>({ status: 'pending' }),
        reason.map((r) => ({ status: 'rejected' as const, reason: r })),
      ),
    }),
    { maxLength: 5, selector: (c) => c.code.toLowerCase() },
  )
  .map((list) => list.map(({ code, verdict }) => ({ code, ...verdict }) as CartCodeStatus))

const byCode = <T extends { code: string }>(a: T, b: T): number =>
  a.code < b.code ? -1 : a.code > b.code ? 1 : 0

describe('AC-8: a refused code is listed with the protocol reason it maps to', () => {
  // Kills: a reason passed through raw (outside DiscountErrorCode, so the session breaks the schema), or a mapping
  // that sends an expired code to the agent as merely invalid.
  it('AC-8: property: over the native reasons and arbitrary others, discountErrorCode answers the mapped DiscountErrorCode and never a value outside the pinned enum', () => {
    fc.assert(
      fc.property(reason, (r) => {
        const answered = discountErrorCode(r)
        expect(answered, `reason ${JSON.stringify(r)}`).toBe(mappedOf(r))
        expect(DISCOUNT_ERROR_CODES, `reason ${JSON.stringify(r)}`).toContain(answered)
      }),
      { numRuns: 300 },
    )
  })

  // Kills: a refused code that silently vanishes from what the agent is told, an accepted or pending code reported as
  // refused, or a refusal that carries a message other than the storefront's.
  it('AC-8: property: acpDiscounts lists exactly the rejected codes in discounts.rejected, each with its mapped reason and the storefront message, and no accepted or pending code there', () => {
    fc.assert(
      fc.property(cartCodes, (codes) => {
        const block = acpDiscounts(codes, [])
        const want = codes
          .filter((c) => c.status === 'rejected')
          .map((c) => ({
            code: c.code,
            reason: mappedOf(c.reason ?? ''),
            message: messageOf(c.reason ?? ''),
          }))

        expect([...block.rejected].sort(byCode)).toEqual([...want].sort(byCode))
        const notRefused = new Set(codes.filter((c) => c.status !== 'rejected').map((c) => c.code))
        expect(block.rejected.filter((r: { code: string }) => notRefused.has(r.code))).toEqual([])
      }),
      { numRuns: 200 },
    )
  })
})

// ─── AC-23 ──────────────────────────────────────────────────────────────────

const BASES = ['save10', 'FreeShip', 'Spring-5', 'extra']
/** One of a few codes, in any case: an engine names a code as it was stored, the cart as it was typed. */
const anyCase = fc
  .tuple(fc.constantFrom(...BASES), fc.constantFrom('lower', 'upper', 'as-is'))
  .map(([base, how]) =>
    how === 'lower' ? base.toLowerCase() : how === 'upper' ? base.toUpperCase() : base,
  )

const label = fc.stringMatching(/^[A-Za-z0-9 %-]{1,20}$/)
const amount = fc.integer({ min: 0, max: 100_000 })

const moneyEffect: fc.Arbitrary<PromotionEffect> = fc
  .record({
    kind: fc.constantFrom('line', 'order', 'shipping'),
    lineId: fc.constantFrom('v-1', 'v-2'),
    amountMinor: amount,
    label,
    code: fc.option(anyCase, { nil: undefined }),
  })
  .map(({ kind, lineId, amountMinor, label: text, code }): PromotionEffect => {
    const coded = code === undefined ? {} : { code }
    if (kind === 'line') return { kind, lineId, amountMinor, label: text, ...coded }
    return { kind, amountMinor, label: text, ...coded }
  })

type Coded = Extract<PromotionEffect, { amountMinor: number }> & { code: string }
const isCoded = (e: PromotionEffect): e is Coded =>
  (e.kind === 'line' || e.kind === 'order' || e.kind === 'shipping') && e.code !== undefined

describe('AC-23: discounts.applied holds each code once, at the sum of its effects', () => {
  // Kills: two effects of one code listed twice (or once per spelling), an amount dropped or counted twice, or an
  // entry the pinned AppliedDiscount refuses, so an agent tells the buyer a discount the totals do not hold.
  it('AC-23: property: over generated applied effect lists (line, order and shipping, with and without a code, codes repeated in any case), Σ applied amounts = Σ the coded effects’ amounts, one entry per code whatever its case at that code’s Σ, unique ids, and each entry validates as AppliedDiscount', () => {
    fc.assert(
      fc.property(fc.array(moneyEffect, { maxLength: 8 }), (applied) => {
        const coded = applied.filter(isCoded)
        const perCode = new Map<string, number>()
        for (const e of coded) {
          const key = e.code.toLowerCase()
          perCode.set(key, (perCode.get(key) ?? 0) + e.amountMinor)
        }
        // The cart holds each code once, in the case the shopper typed it, and the engine accepted it.
        const codes: CartCodeStatus[] = [...perCode.keys()].map((code) => ({
          code,
          status: 'accepted',
        }))

        const block = acpDiscounts(codes, applied)
        const entries = block.applied as Array<{ id: string; code?: string; amount: number }>
        const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

        expect(sum(entries.map((e) => e.amount))).toBe(sum(coded.map((e) => e.amountMinor)))
        expect(entries.map((e) => e.id.toLowerCase()).sort()).toEqual([...perCode.keys()].sort())
        expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length)
        for (const entry of entries) {
          expect(entry.amount, `amount of ${entry.id}`).toBe(perCode.get(entry.id.toLowerCase()))
          expect(validateAcp(APPLIED_DISCOUNT, entry), `entry ${entry.id}`).toEqual([])
        }
      }),
      { numRuns: 300 },
    )
  })
})
