import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Caller, ToolDefinition, ToolResult } from '@nymbalhq/types'
import { assistantTools } from '../../src/assistant/loop.js'
import { assistantEvalInput } from '../../src/assistant/stamp.js'
import { agentCaller, serveWithAgents, type AgentStore } from '../support/agents.js'
import { createKernel, seedVariant, type Seeded } from '../support/kernel.js'
import { cartHandleOf, committedCount, contentOf } from '../support/mcp.js'
import {
  addLine,
  putCode,
  readCart,
  seedPromotion,
  uniqueCode,
  type PricedCart,
  type Shop,
} from '../support/promotions.js'
import { primedShopper } from '../support/security.js'

// The cart's code routes as agent tools on /api/mcp, taking the cart handle as every other cart tool does, served as
// `nymbal dev` serves them (SQLite, the native engine): an agent adds and removes a cart's codes, the browser's cookie
// routes answer as before, and the admin's assistant is offered neither tool.

const CODE_TOOLS = ['cart_addCode', 'cart_removeCode']
const CART_COOKIE = 'nymbal.cart'
const ADMIN: Caller = {
  auth: { userId: 'code-tools-admin', roles: ['admin'] },
  agent: { name: 'code-tools-assistant' },
}

let store: AgentStore
let seeded: Seeded
/** A 10% code, stored in upper case. */
let tenPercent: string

beforeAll(async () => {
  store = await serveWithAgents(await createKernel({ dialect: 'sqlite' }))
  seeded = await seedVariant(store.kernel, 10_000, { priceMinor: 2_350 })
  tenPercent = uniqueCode('TEN').toUpperCase()
  await seedPromotion(store.kernel, { code: tenPercent, kind: 'percent', percentBps: 1_000 })
}, 60_000)

afterAll(async () => {
  await store?.stop()
})

const agent = agentCaller('code-tools-bot')

function data<T = Record<string, unknown>>(result: ToolResult, what: string): T {
  expect(result.isError ?? false, `${what}: ${JSON.stringify(result.structuredContent)}`).toBe(
    false,
  )
  return contentOf(result).structured as T
}

/** A browser holding the cart `token` in its cookie. */
async function browserOn(token: string): Promise<Shop> {
  return primedShopper(store.baseUrl, new Map([[CART_COOKIE, token]]))
}

async function cookieCart(token: string): Promise<PricedCart> {
  const res = await readCart(await browserOn(token))
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data!
}

const statuses = (cart: PricedCart) =>
  cart.promotions.codes.map((c) => ({ code: c.code.toLowerCase(), status: c.status }))

describe('AC-4: cart_addCode and cart_removeCode take the cart handle', () => {
  // Kills: the code routes still kept from agents (tool: false), listed without the handle, or acting on another
  // cart than the one the handle names; the cookie routes changed by the move.
  it('AC-4: with a cart’s handle cart_addCode adds the code to that cart and cart_get answers it accepted with totals.discountTotalMinor = ⌊subtotal / 10⌋, the cookie route reading the same; cart_removeCode takes it off, and the cookie routes add and remove as before', async () => {
    const opened = await store.mcp.call(
      'cart_addItem',
      { variantId: seeded.variantId, qty: 3 },
      agent,
    )
    const cart = cartHandleOf(opened)
    expect(cart, JSON.stringify(opened.structuredContent)).toEqual(expect.any(String))
    const code = tenPercent.toLowerCase()

    data(await store.mcp.call('cart_addCode', { cart, code }, agent), 'cart_addCode')
    const got = data<PricedCart>(await store.mcp.call('cart_get', { cart }, agent), 'cart_get')
    const viaCookie = await cookieCart(cart!)

    expect(statuses(got)).toEqual([{ code, status: 'accepted' }])
    expect(got.totals.discountTotalMinor).toBe(Math.floor(got.subtotalMinor / 10))
    expect(got.totals.totalMinor).toBe(got.subtotalMinor - got.totals.discountTotalMinor)
    expect({ codes: statuses(viaCookie), totals: viaCookie.totals }).toEqual({
      codes: statuses(got),
      totals: got.totals,
    })

    const removed = data<PricedCart>(
      await store.mcp.call('cart_removeCode', { cart, code }, agent),
      'cart_removeCode',
    )
    const after = data<PricedCart>(await store.mcp.call('cart_get', { cart }, agent), 'cart_get')
    expect(removed.promotions.codes).toEqual([])
    expect(after.promotions.codes).toEqual([])
    expect(after.totals.totalMinor).toBe(after.subtotalMinor)

    // The browser's own routes on the same cart, by cookie, as before the move.
    const browser = await browserOn(cart!)
    const put = await putCode(browser, code)
    expect(put.status, JSON.stringify(put.body)).toBe(200)
    expect(statuses(put.body.data!)).toEqual([{ code, status: 'accepted' }])
    const dropped = await browser.call<PricedCart>(
      'DELETE',
      `/api/cart/codes/${encodeURIComponent(code)}`,
    )
    expect(dropped.status, JSON.stringify(dropped.body)).toBe(200)
    expect(dropped.body.data?.promotions.codes).toEqual([])
  })

  // Kills: a handle-less call that opens a new cart and reports the code added, so the agent believes a cart it can
  // never reach holds its code.
  it('AC-4: called with no handle, cart_addCode and cart_removeCode each answer isError cart.missing and open no cart', async () => {
    const carts = committedCount(store.kernel.target, 'carts')

    const added = await store.mcp.call('cart_addCode', { code: tenPercent }, agent)
    const removed = await store.mcp.call('cart_removeCode', { code: tenPercent }, agent)

    expect(
      [added, removed].map((r) => ({
        isError: r.isError ?? false,
        code: contentOf(r).structured['code'],
        handle: cartHandleOf(r),
      })),
    ).toEqual([
      { isError: true, code: 'cart.missing', handle: undefined },
      { isError: true, code: 'cart.missing', handle: undefined },
    ])
    expect(committedCount(store.kernel.target, 'carts')).toBe(carts)
  })
})

describe('AC-5: the admin’s assistant is offered neither code tool', () => {
  // Kills: making the routes tools puts a cart write in front of the assistant and changes its eval input, so the
  // stamp a real provider run recorded no longer matches.
  it('AC-5: the full tool list holds cart_addCode and cart_removeCode, assistantTools over it holds neither, and assistantEvalInput is the same with and without them registered', async () => {
    const all = (caller: Caller): ToolDefinition[] => store.mcp.list(caller) as ToolDefinition[]
    const without = (caller: Caller): ToolDefinition[] =>
      all(caller).filter((t) => !CODE_TOOLS.includes(t.name))
    const names = all(ADMIN).map((t) => t.name)

    expect(CODE_TOOLS.filter((n) => names.includes(n))).toEqual(CODE_TOOLS)
    expect(assistantTools(all(ADMIN)).filter((t) => CODE_TOOLS.includes(t.name))).toEqual([])
    expect(without(ADMIN).length).toBe(all(ADMIN).length - CODE_TOOLS.length)
    expect(assistantEvalInput({ list: all })).toEqual(assistantEvalInput({ list: without }))
  })
})

// ─── AC-13 ──────────────────────────────────────────────────────────────────

/** A code a shopper might type: words around a space, a percent sign, a slash or non-ASCII letters. */
const typedCode = fc
  .tuple(
    fc.stringMatching(/^[A-Za-z0-9]{1,8}$/),
    fc.constantFrom(' ', '%', '/', '%2F', ' 10%', 'é', 'ß', 'Ünï', '/../'),
    fc.stringMatching(/^[A-Za-z0-9]{1,8}$/),
  )
  .map(([a, symbol, b]) => `${a}${symbol}${b}`)

async function cartWithLine(): Promise<{ shop: Shop; token: string }> {
  const shop = await primedShopper(store.baseUrl)
  const added = await addLine(shop, seeded, 1)
  expect(added.status, JSON.stringify(added.body)).toBe(200)
  return { shop, token: shop.jar.get(CART_COOKIE)! }
}

describe('AC-13: every code a cart can hold can be taken off it', () => {
  // Kills: a code typed with a symbol that the DELETE can never name (the path decoded into another route or another
  // code), so a rejected code stays on the cart for good and five of them hold it at cart.code_limit.
  it('AC-13: property: a code holding a space, %, / or non-ASCII letters, added through POST, is removed by DELETE /api/cart/codes/<encodeURIComponent(code)> and by cart_removeCode with the cart handle, each leaving the cart with no code', async () => {
    await fc.assert(
      fc.asyncProperty(typedCode, async (code) => {
        for (const how of ['cookie', 'tool'] as const) {
          const { shop, token } = await cartWithLine()
          const put = await putCode(shop, code)
          expect(put.status, `${how} ${JSON.stringify(put.body)}`).toBe(200)
          expect(put.body.data?.promotions.codes.map((c) => c.code)).toEqual([code])

          const answer =
            how === 'cookie'
              ? await shop.call<PricedCart>('DELETE', `/api/cart/codes/${encodeURIComponent(code)}`)
              : await store.mcp.call('cart_removeCode', { cart: token, code }, agent)
          const ok = 'status' in answer ? answer.status === 200 : answer.isError !== true
          expect(ok, `${how}: ${JSON.stringify(answer)}`).toBe(true)
          expect((await cookieCart(token)).promotions.codes, `${how}: ${code}`).toEqual([])
        }
      }),
      { numRuns: 12 },
    )
  }, 60_000)

  // Kills: `.` or `..` accepted onto a cart, where no browser's DELETE can name it (the URL resolves the segment away).
  it('AC-13: POST /api/cart/codes with ".", "..", " . " or "  ..  " answers 400 cart.code_invalid, and the cart holds no code', async () => {
    const { shop, token } = await cartWithLine()
    const seen = []
    for (const code of ['.', '..', ' . ', '  ..  ']) {
      const res = await putCode(shop, code)
      seen.push({ code, status: res.status, error: res.body.error?.code })
    }
    expect(seen).toEqual(
      ['.', '..', ' . ', '  ..  '].map((code) => ({
        code,
        status: 400,
        error: 'cart.code_invalid',
      })),
    )
    expect((await cookieCart(token)).promotions.codes).toEqual([])
  })
})
