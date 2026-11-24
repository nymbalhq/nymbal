import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import { formatPrice } from '../format.js'
import { setupMockClient } from '../testing/index.js'

// The discount code block on `nymbal-cart-page`, and what the cart page and the checkout show of a cart's discount
// before the store settles. The cart store under the elements is the mock client's; its code calls are the test's
// own, answering as the real store does: the state's `promotions`, `totals`, `error` and `errorCode` change, the call
// resolves.

const CART_PAGE = 'nymbal-cart-page'
const CHECKOUT = 'nymbal-checkout'

interface CodeStatus {
  code: string
  status: 'accepted' | 'rejected' | 'pending'
  reason?: string
}

interface CartStoreDouble {
  getState(): Record<string, unknown>
  setState(partial: Record<string, unknown>): void
  addCode?: (code: string) => Promise<void>
  removeCode?: (code: string) => Promise<void>
}

/** What the shopper reads for a code on the cart (the storefront's messages). */
const REASON_MESSAGES: Record<string, string> = {
  expired: 'This code has expired.',
  below_minimum: "Your order is below this code's minimum spend.",
  cap_reached: 'This code has been fully used.',
  wrong_currency: "This code can't be used in this currency.",
  one_code_per_order: 'Only one code can be used per order.',
  free_order_unsupported: "This code can't be used on this order.",
}
const NOT_VALID = "This code isn't valid."
const PENDING = "We couldn't check this code just now."

function messageFor(c: CodeStatus): string {
  if (c.status === 'accepted') return 'Applied'
  if (c.status === 'pending') return PENDING
  const reason = c.reason ?? ''
  return Object.hasOwn(REASON_MESSAGES, reason) ? REASON_MESSAGES[reason]! : NOT_VALID
}

/** What a refused Apply says, by the refusal's API code (null: no answer reached the store). */
const APPLY_REFUSALS: Array<[string | null, string]> = [
  ['cart.code_limit', 'You can add up to five codes.'],
  ['cart.code_invalid', 'Enter a valid code of up to 64 characters.'],
  ['cart.missing', 'Your cart has expired. Reload the page to start again.'],
  ['cart.promotions_unavailable', "We couldn't check your code just now. Please try again."],
  ['rate_limit.exceeded', "We couldn't check your code just now. Please try again."],
  ['internal.error', "We couldn't check your code just now. Please try again."],
  [null, "We couldn't check your code just now. Please try again."],
]

const LINE = {
  variantId: 'v-lamp',
  productId: 'p-lamp',
  productName: 'Lamp',
  variantName: '',
  imageUrl: '',
  qty: 1,
}

/** A settled cart store state of one line at `subtotalMinor`, its totals and its codes as the API gave them. */
function cartState(p: {
  subtotalMinor: number
  discountTotalMinor?: number
  codes?: CodeStatus[]
  currency?: string
  empty?: boolean
}): Record<string, unknown> {
  const currency = p.currency ?? 'GBP'
  const discount = p.discountTotalMinor ?? 0
  const codes = p.codes ?? []
  return {
    items: p.empty === true ? [] : [{ ...LINE, priceMinor: p.subtotalMinor }],
    subtotalMinor: p.empty === true ? 0 : p.subtotalMinor,
    currency,
    itemCount: p.empty === true ? 0 : 1,
    loading: false,
    error: null,
    errorCode: null,
    totals: {
      currency,
      subtotalMinor: p.subtotalMinor,
      discountTotalMinor: discount,
      shippingTotalMinor: 0,
      shippingDiscountMinor: 0,
      taxTotalMinor: 0,
      totalMinor: p.subtotalMinor - discount,
      pricesIncludeTax: false,
      lines: [],
      applied: [],
    },
    promotions: { codes, unavailable: codes.some((c) => c.status === 'pending') },
  }
}

function cartStore(): CartStoreDouble {
  return (setupMockClient() as unknown as { cart: CartStoreDouble }).cart
}

async function settle(el: Element): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await (el as Element & { updateComplete?: Promise<unknown> }).updateComplete
    await Promise.resolve()
  }
}

async function mount(tag: string, attributes: Record<string, string> = {}): Promise<HTMLElement> {
  const el = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value)
  document.body.append(el)
  await settle(el)
  return el
}

/** Every element matching `selector` in `root` and in every open shadow root beneath it. */
function deepAll(root: ParentNode, selector: string): Element[] {
  const found = [...root.querySelectorAll(selector)]
  for (const node of root.querySelectorAll('*')) {
    if (node.shadowRoot) found.push(...deepAll(node.shadowRoot, selector))
  }
  return found
}

function all(el: HTMLElement, id: string): HTMLElement[] {
  if (el.shadowRoot === null) throw new Error(`<${el.localName}> has no open shadow root`)
  return deepAll(el.shadowRoot, `[data-testid="${id}"]`) as HTMLElement[]
}

function byTestId<T extends HTMLElement = HTMLElement>(el: HTMLElement, id: string): T {
  const found = all(el, id)
  expect(found, `[data-testid="${id}"] in <${el.localName}>`).toHaveLength(1)
  return found[0] as T
}

const squash = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, '')
const textOf = (node: Element): string => (node.textContent ?? '').replace(/\s+/g, ' ').trim()

/** The name a screen reader gives a control: aria-label, aria-labelledby, its label, else its text. */
function nameOf(control: HTMLElement): string {
  const aria = control.getAttribute('aria-label')
  if (aria !== null && aria.trim() !== '') return aria.trim()
  const root = control.getRootNode() as ShadowRoot | Document
  const by = control.getAttribute('aria-labelledby')
  if (by !== null) {
    return by
      .split(/\s+/)
      .map((id) => textOf(root.getElementById(id) ?? document.createElement('i')))
      .join(' ')
      .trim()
  }
  const wrapping = control.closest('label')
  if (wrapping !== null) return textOf(wrapping)
  if (control.id !== '') {
    const label = root.querySelector(`label[for="${control.id}"]`)
    if (label !== null) return textOf(label)
  }
  return textOf(control)
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  input.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
}

async function apply(el: HTMLElement, value: string): Promise<void> {
  type(byTestId<HTMLInputElement>(el, 'discount-code-input'), value)
  byTestId<HTMLButtonElement>(el, 'discount-code-apply').click()
  await settle(el)
}

/** Each listed code as the shopper reads it. */
function listed(el: HTMLElement): Array<{ code: string; status: string; message: string }> {
  return all(el, 'discount-code').map((node) => ({
    code: node.getAttribute('data-code') ?? '',
    status: node.getAttribute('data-status') ?? '',
    message: textOf(
      deepAll(node, '[data-testid="discount-code-message"]')[0] ?? document.createElement('i'),
    ),
  }))
}

/** The refusal the code block shows, or null when none is shown. */
function shownError(el: HTMLElement): string | null {
  const [node] = all(el, 'discount-code-error')
  if (node === undefined || node.hidden || textOf(node) === '') return null
  return textOf(node)
}

const codeText = fc.stringMatching(/^[A-Z0-9][A-Z0-9-]{0,9}$/)
const anyReason = fc.oneof(
  fc.constantFrom(
    ...Object.keys(REASON_MESSAGES),
    'unknown',
    'inactive',
    'unanswered',
    'constructor',
  ),
  fc.stringMatching(/^[a-z_]{1,16}$/),
)
const codeStatus: fc.Arbitrary<CodeStatus> = fc.oneof(
  fc.record({ code: codeText, status: fc.constant('accepted' as const) }),
  fc.record({ code: codeText, status: fc.constant('pending' as const) }),
  fc.record({ code: codeText, status: fc.constant('rejected' as const), reason: anyReason }),
)
const codeList = fc.uniqueArray(codeStatus, { maxLength: 5, selector: (c) => c.code })

// ─── AC-14 ──────────────────────────────────────────────────────────────────

describe('AC-14: the code block on the cart page', () => {
  // Kills: a field that calls nothing, sends the untrimmed text, sends a blank code, or keeps the code typed after it
  // was applied; an input with no name or no 64-character bound.
  it('AC-14: Apply with "  save10 " calls cart.addCode("save10") once, clears the input and shows no error; a blank input calls nothing; the input is labelled "Discount code" and takes 64 characters, the button reads Apply', async () => {
    const cart = cartStore()
    cart.setState(cartState({ subtotalMinor: 2_000 }))
    const addCode = vi.fn(async (code: string) => {
      cart.setState({
        ...cartState({
          subtotalMinor: 2_000,
          discountTotalMinor: 200,
          codes: [{ code, status: 'accepted' }],
        }),
      })
    })
    cart.addCode = addCode
    const el = await mount(CART_PAGE)
    const input = byTestId<HTMLInputElement>(el, 'discount-code-input')

    expect({ maxlength: input.getAttribute('maxlength'), name: nameOf(input) }).toEqual({
      maxlength: '64',
      name: 'Discount code',
    })
    expect(nameOf(byTestId(el, 'discount-code-apply'))).toBe('Apply')

    for (const blank of ['', '   ']) await apply(el, blank)
    expect(addCode).toHaveBeenCalledTimes(0)

    await apply(el, '  save10 ')
    await vi.waitFor(() => expect(listed(el).map((c) => c.code)).toEqual(['save10']))
    expect(addCode.mock.calls).toEqual([['save10']])
    expect(byTestId<HTMLInputElement>(el, 'discount-code-input').value).toBe('')
    expect(shownError(el)).toBeNull()
  })

  // Kills: a rejected code listed with no reason, a pending code shown as applied, or a status the page cannot style.
  it('AC-14: property: each code on the cart is listed in order with its data-code, its data-status, the message for its status and reason, and a Remove labelled "Remove code <code>"', async () => {
    await fc.assert(
      fc.asyncProperty(codeList, async (codes) => {
        document.body.innerHTML = ''
        const cart = cartStore()
        cart.setState(cartState({ subtotalMinor: 3_000, codes }))
        const el = await mount(CART_PAGE)

        expect(listed(el)).toEqual(
          codes.map((c) => ({ code: c.code, status: c.status, message: messageFor(c) })),
        )
        expect(all(el, 'discount-code-remove').map(nameOf)).toEqual(
          codes.map((c) => `Remove code ${c.code}`),
        )
      }),
      { numRuns: 40 },
    )
  })

  // Kills: a Remove that calls nothing or removes another code.
  it('AC-14: Remove on the second code calls cart.removeCode with that code once, and the list then holds the first alone', async () => {
    const codes: CodeStatus[] = [
      { code: 'SAVE10', status: 'accepted' },
      { code: 'OLD-5', status: 'rejected', reason: 'expired' },
    ]
    const cart = cartStore()
    cart.setState(cartState({ subtotalMinor: 3_000, discountTotalMinor: 300, codes }))
    const removeCode = vi.fn(async (code: string) => {
      cart.setState({
        promotions: { codes: codes.filter((c) => c.code !== code), unavailable: false },
      })
    })
    cart.removeCode = removeCode
    const el = await mount(CART_PAGE)

    const removes = all(el, 'discount-code-remove')
    expect(removes, 'one Remove per listed code').toHaveLength(codes.length)
    removes[1]!.click()
    await vi.waitFor(() => expect(listed(el).map((c) => c.code)).toEqual(['SAVE10']))
    expect(removeCode.mock.calls).toEqual([['OLD-5']])
  })

  // Kills: the Estimated Total still the subtotal, a discount row with nothing to show, or a discount the API did not
  // give.
  it('AC-14: property: cart-summary-discount shows "−<discount>" only when totals.discountTotalMinor > 0, and cart-summary-total shows totals.totalMinor', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 100, max: 500_000 }),
        fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 100 })),
        fc.constantFrom('GBP', 'EUR'),
        async (subtotalMinor, share, currency) => {
          document.body.innerHTML = ''
          const discount = Math.floor((subtotalMinor * share) / 100)
          const cart = cartStore()
          cart.setState(
            cartState({
              subtotalMinor,
              discountTotalMinor: discount,
              currency,
              codes: discount > 0 ? [{ code: 'SAVE', status: 'accepted' }] : [],
            }),
          )
          const el = await mount(CART_PAGE)

          const rows = all(el, 'cart-summary-discount').map((n) => squash(n.textContent))
          const want = `−${formatPrice(discount, currency)}`
          expect({ rows: rows.length, each: rows.every((r) => r.includes(want)) }).toEqual({
            rows: discount > 0 ? 1 : 0,
            each: true,
          })
          expect(squash(byTestId(el, 'cart-summary-total').textContent)).toContain(
            formatPrice(subtotalMinor - discount, currency),
          )
        },
      ),
      { numRuns: 30 },
    )
  })

  // Kills: a code field on an empty cart, where there is nothing to discount.
  it('AC-14: the code block shows on a cart with lines and is gone once the cart is empty', async () => {
    const cart = cartStore()
    cart.setState(
      cartState({ subtotalMinor: 1_500, codes: [{ code: 'SAVE', status: 'accepted' }] }),
    )
    const el = await mount(CART_PAGE)
    expect(all(el, 'discount-code-input')).toHaveLength(1)

    cart.setState(cartState({ subtotalMinor: 0, empty: true }))
    await settle(el)
    expect([all(el, 'discount-code-input'), all(el, 'discount-code')]).toEqual([[], []])
  })
})

// ─── AC-15 ──────────────────────────────────────────────────────────────────

describe('AC-15: a refused Apply says why and keeps the code typed', () => {
  // Kills: a shopper told nothing of a limit or an outage, told the wrong thing, or made to retype the code; an error
  // that stays after the code is applied.
  it('AC-15: for each refusal, discount-code-error (role alert) shows the message for its errorCode and the input keeps the code; the next successful Apply removes the error and clears the input', async () => {
    const seen: Array<{
      errorCode: string | null
      error: string | null
      role: string | null
      kept: string
    }> = []
    const after: Array<{ error: string | null; input: string }> = []
    for (const [errorCode] of APPLY_REFUSALS) {
      document.body.innerHTML = ''
      const cart = cartStore()
      cart.setState(cartState({ subtotalMinor: 2_000 }))
      cart.addCode = async () => {
        cart.setState({ error: 'the raw refusal text', errorCode })
      }
      const el = await mount(CART_PAGE)

      await apply(el, 'SAVE10')
      await vi.waitFor(() => expect(shownError(el)).not.toBeNull())
      seen.push({
        errorCode,
        error: shownError(el),
        role: all(el, 'discount-code-error')[0]?.getAttribute('role') ?? null,
        kept: byTestId<HTMLInputElement>(el, 'discount-code-input').value,
      })

      cart.addCode = async (code: string) => {
        cart.setState({
          ...cartState({ subtotalMinor: 2_000, codes: [{ code, status: 'accepted' }] }),
        })
      }
      byTestId<HTMLButtonElement>(el, 'discount-code-apply').click()
      await vi.waitFor(() => expect(listed(el).map((c) => c.code)).toEqual(['SAVE10']))
      after.push({
        error: shownError(el),
        input: byTestId<HTMLInputElement>(el, 'discount-code-input').value,
      })
    }

    expect(seen).toEqual(
      APPLY_REFUSALS.map(([errorCode, message]) => ({
        errorCode,
        error: message,
        role: 'alert',
        kept: 'SAVE10',
      })),
    )
    expect(after).toEqual(APPLY_REFUSALS.map(() => ({ error: null, input: '' })))
  })
})

// ─── AC-18 (elements) ───────────────────────────────────────────────────────

describe('AC-18: a server-rendered cart shows its discount before the store settles', () => {
  // Kills: a server render that shows the subtotal as the total and no codes, then shifts when the store settles.
  it('AC-18: property: nymbal-cart-page and nymbal-checkout given a cart projection with a discount, while the store is still loading, show "−<discountTotalMinor>" and totalMinor in their summaries, and the cart page lists the projection’s codes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 100, max: 500_000 }),
        fc.integer({ min: 1, max: 100 }),
        async (subtotalMinor, share) => {
          const discountTotalMinor = Math.floor((subtotalMinor * share) / 100)
          const totalMinor = subtotalMinor - discountTotalMinor
          const projection = {
            items: [{ ...LINE, priceMinor: subtotalMinor }],
            subtotalMinor,
            currency: 'GBP',
            itemCount: 1,
            discountTotalMinor,
            totalMinor,
            codes: [{ code: 'SAVE10', status: 'accepted' }],
          }
          const shown: Record<string, { discount: string[]; total: string }> = {}
          let cartPageCodes: ReturnType<typeof listed> = []
          for (const [tag, prefix] of [
            [CART_PAGE, 'cart'],
            [CHECKOUT, 'checkout'],
          ] as const) {
            document.body.innerHTML = ''
            cartStore().setState({ loading: true })
            const el = await mount(tag, { cart: JSON.stringify(projection) })
            shown[tag] = {
              discount: all(el, `${prefix}-summary-discount`).map((n) => squash(n.textContent)),
              total: squash(byTestId(el, `${prefix}-summary-total`).textContent),
            }
            if (tag === CART_PAGE) cartPageCodes = listed(el)
          }

          expect(cartPageCodes).toEqual([{ code: 'SAVE10', status: 'accepted', message: 'Applied' }])

          for (const tag of [CART_PAGE, CHECKOUT]) {
            expect(shown[tag]!.discount, tag).toEqual([
              expect.stringContaining(`−${formatPrice(discountTotalMinor, 'GBP')}`),
            ])
            expect(shown[tag]!.total, tag).toContain(formatPrice(totalMinor, 'GBP'))
          }
        },
      ),
      { numRuns: 15 },
    )
  })
})
