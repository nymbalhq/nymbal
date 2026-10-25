import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import { setupMockClient } from '../testing/index.js'

// `nymbal-notify-me`: an out-of-stock variant's "email me when it's back" form. It follows the product store's selected
// variant as the stock badge does (rendered from its attributes until the store holds its product), and submits once
// per submission through `client.adapter.alerts.subscribe` as the review form submits through its own SDK call.
// The schema, parts, server render, hydration and entry are the convention suites' (elements-schema.test.ts,
// ssr/render-element.test.ts); this file holds what only this element does.

const TAG = 'nymbal-notify-me'
const EVENT = 'nymbal:alert:requested'
const NOTICE = 'Check your inbox to confirm.'

interface Deferred {
  promise: Promise<void>
  resolve(): void
  reject(err: Error): void
}

function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (err: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Lets the element's handlers and renders run. */
async function flush(el: Element): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await (el as Element & { updateComplete?: Promise<unknown> }).updateComplete
  }
}

const find = <T extends Element>(el: Element, id: string): T | null =>
  (el.shadowRoot?.querySelector(`[data-testid="${id}"]`) as T | null | undefined) ?? null

function byTestId<T extends Element>(el: Element, id: string): T {
  const found = find<T>(el, id)
  if (found === null) throw new Error(`<${el.localName}> renders no [data-testid="${id}"]`)
  return found
}

const shownText = (el: Element, id: string): string => {
  const node = find(el, id)
  return node === null || node.hasAttribute('hidden') ? '' : (node.textContent ?? '').trim()
}

interface Variant {
  id: string
  stock: number
}

function productWith(variants: Variant[]) {
  return {
    id: 'p1',
    slug: 'p1',
    name: 'Product',
    description: '',
    shortDescription: '',
    status: 'active',
    type: 'physical',
    media: [],
    variantCount: variants.length,
    inStock: variants.some((v) => v.stock > 0),
    priceRange: null,
    currency: 'GBP',
    priceMinor: 1000,
    variants: variants.map((v, i) => ({
      id: v.id,
      sku: `SKU-${i}`,
      name: `Variant ${i}`,
      priceMinor: 1000,
      stock: v.stock,
      options: [{ name: 'Size', value: `S${i}` }],
    })),
  }
}

type Client = Record<string, unknown> & {
  product: { setState(partial: Record<string, unknown>): void }
}

function installAlerts(client: Client, subscribe: (input: unknown) => Promise<unknown>): void {
  client['adapter'] = { alerts: { subscribe } }
}

async function mount(attrs: Record<string, string>): Promise<HTMLElement> {
  const el = document.createElement(TAG)
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value)
  document.body.append(el)
  await flush(el)
  return el
}

function type(el: Element, value: string): void {
  const input = byTestId<HTMLInputElement>(el, 'notify-me-email')
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  input.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
}

const email = fc
  .tuple(fc.stringMatching(/^[a-z][a-z0-9]{0,9}$/), fc.stringMatching(/^[a-z]{2,8}$/))
  .map(([local, domain]) => `${local}@${domain}.test`)

type Kind = 'back_in_stock' | 'price_drop'

const kindFor = (stock: number): Kind => (stock <= 0 ? 'back_in_stock' : 'price_drop')

/** The form a variant at `stock` shows: its kind and its heading. */
const formFor = (stock: number): { kind: Kind; heading: string } =>
  stock <= 0
    ? { kind: 'back_in_stock', heading: "Email me when it's back" }
    : { kind: 'price_drop', heading: 'Email me if the price drops' }

/** The form the element shows, or null for none; the heading with its apostrophe made plain. */
function shownForm(el: Element): { kind: string | null; heading: string } | null {
  const form = find<HTMLFormElement>(el, 'notify-me')
  if (form === null) return null
  const heading = form.querySelector('[part~="heading"]')?.textContent ?? ''
  return { kind: form.getAttribute('data-kind'), heading: heading.trim().replace('’', "'") }
}

/** The parts the element's shadow root renders, as a sorted set. */
function partsOf(el: Element): string[] {
  const parts = new Set<string>()
  for (const node of el.shadowRoot?.querySelectorAll('[part]') ?? []) {
    for (const part of (node.getAttribute('part') ?? '').split(/\s+/)) if (part) parts.add(part)
  }
  return [...parts].sort()
}

/** The product store's product with each variant at its stock, and the one selected. */
function select(client: Client, variants: Variant[], selectedId: string): void {
  const product = productWith(variants)
  client.product.setState({
    product,
    selectedVariant: product.variants.find((v) => v.id === selectedId),
    loading: false,
  })
}

describe('nymbal-notify-me', () => {
  it('AC-5: property: from its attributes alone, a stock of 0 or less renders the back-in-stock form and a stock above 0 renders the price-drop form', async () => {
    expect(customElements.get(TAG), `${TAG} is defined by registerComponents()`).toBeDefined()
    setupMockClient()
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: -3, max: 20 }), async (stock) => {
        document.body.innerHTML = ''
        const el = await mount({
          'product-id': 'p-attrs',
          'variant-id': 'v-attrs',
          stock: String(stock),
        })
        expect(shownForm(el), `stock ${stock}`).toEqual(formFor(stock))
      }),
      { numRuns: 30, examples: [[0], [1]] },
    )
  })

  it('AC-8: the email field is a required type="email" input whose label is in the same shadow root, and the button is type="submit" in the form', async () => {
    expect(customElements.get(TAG), `${TAG} is defined by registerComponents()`).toBeDefined()
    setupMockClient()
    const el = await mount({ 'product-id': 'p1', 'variant-id': 'v0', stock: '0' })
    const input = byTestId<HTMLInputElement>(el, 'notify-me-email')
    const label = el.shadowRoot!.querySelector(`label[for="${input.id}"]`)
    const submit = byTestId<HTMLButtonElement>(el, 'notify-me-submit')

    expect({
      type: input.getAttribute('type'),
      required: input.required,
      labelled: input.id !== '' && (label?.textContent ?? '').trim() !== '',
      submit: submit.getAttribute('type'),
      sameForm: submit.closest('form') === input.closest('form'),
    }).toEqual({ type: 'email', required: true, labelled: true, submit: 'submit', sameForm: true })
  })

  it('AC-5: property: once the product store holds its product, the form follows the selected variant, back-in-stock for an out-of-stock one and price-drop for an in-stock one, switching both ways; a submit names the variant followed and the kind of its state, never the server’s first', async () => {
    expect(customElements.get(TAG), `${TAG} is defined by registerComponents()`).toBeDefined()
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 2, maxLength: 4 }),
        fc.array(fc.nat({ max: 3 }), { minLength: 1, maxLength: 6 }),
        fc.nat({ max: 3 }),
        email,
        async (stocks, picks, last, address) => {
          document.body.innerHTML = ''
          const variants = stocks.map((stock, i) => ({ id: `v${i}`, stock }))
          const product = productWith(variants)
          const client = setupMockClient() as unknown as Client
          const sent: unknown[] = []
          installAlerts(client, async (input) => {
            sent.push(input)
            return { status: 'pending' }
          })
          client.product.setState({ product, selectedVariant: product.variants[0], loading: false })
          const el = await mount({
            'product-id': 'p1',
            'variant-id': 'v0',
            stock: String(variants[0]!.stock),
          })

          for (const pick of picks) {
            const chosen = product.variants[pick % product.variants.length]!
            client.product.setState({ selectedVariant: chosen })
            await flush(el)
            expect(shownForm(el), `${chosen.id} at stock ${chosen.stock}`).toEqual(
              formFor(chosen.stock),
            )
          }

          const ending = product.variants[last % product.variants.length]!
          client.product.setState({ selectedVariant: ending })
          await flush(el)
          type(el, address)
          byTestId<HTMLButtonElement>(el, 'notify-me-submit').click()
          await flush(el)
          expect(sent).toEqual([
            { email: address, variantId: ending.id, kind: kindFor(ending.stock) },
          ])
        },
      ),
      {
        numRuns: 30,
        examples: [
          // The server's first is in stock and the shopper ends on an out-of-stock one, and the reverse.
          [[3, 0], [1, 0, 1], 1, 'ada@example.test'],
          [[0, 2], [1, 0], 1, 'bea@example.test'],
        ],
      },
    )
  })

  it('AC-5: in stock and out of stock, the parts rendered at rest are the same set', async () => {
    expect(customElements.get(TAG), `${TAG} is defined by registerComponents()`).toBeDefined()
    setupMockClient()
    const out = await mount({ 'product-id': 'p1', 'variant-id': 'v0', stock: '0' })
    const inStock = await mount({ 'product-id': 'p1', 'variant-id': 'v1', stock: '5' })
    expect(shownForm(inStock)?.kind).toBe('price_drop')
    expect(partsOf(inStock)).toEqual(partsOf(out))
  })

  it('AC-5: property: k = 1-5 submits in stock (clicks and requestSubmit()) while the call is held make one alerts.subscribe call with kind price_drop; acceptance shows the notice and emits nymbal:alert:requested once with that kind', async () => {
    expect(customElements.get(TAG), `${TAG} is defined by registerComponents()`).toBeDefined()
    await fc.assert(
      fc.asyncProperty(email, fc.integer({ min: 1, max: 5 }), async (address, k) => {
        document.body.innerHTML = ''
        const held = deferred()
        const client = setupMockClient() as unknown as Client
        const sent: unknown[] = []
        installAlerts(client, async (input) => {
          sent.push(input)
          await held.promise
          return { status: 'pending' }
        })
        const events: unknown[] = []
        const listener = (e: Event): void => {
          events.push((e as CustomEvent).detail)
        }
        document.addEventListener(EVENT, listener)
        try {
          const el = await mount({ 'product-id': 'p9', 'variant-id': 'v9', stock: '4' })
          expect(shownForm(el)?.kind, 'the in-stock form').toBe('price_drop')
          type(el, address)
          const button = byTestId<HTMLButtonElement>(el, 'notify-me-submit')
          const form = button.closest('form')!
          for (let i = 0; i < k; i += 1) {
            if (i % 2 === 0) button.click()
            else form.requestSubmit()
          }
          await flush(el)
          expect(sent, `${k} submits while held`).toEqual([
            { email: address, variantId: 'v9', kind: 'price_drop' },
          ])

          held.resolve()
          await flush(el)
          byTestId<HTMLButtonElement>(el, 'notify-me-submit').click()
          await flush(el)
          expect({ calls: sent.length, notice: shownText(el, 'notify-me-notice'), events }).toEqual(
            {
              calls: 1,
              notice: NOTICE,
              events: [{ kind: 'price_drop', variantId: 'v9' }],
            },
          )
        } finally {
          document.removeEventListener(EVENT, listener)
        }
      }),
      { numRuns: 25 },
    )
  })

  it('AC-5: acceptance is per variant and kind: after an accepted back-in-stock submit, the same variant in stock shows the price-drop form enabled with no notice and its submit makes one price_drop call; back out of stock the accepted notice shows again and a further submit sends nothing', async () => {
    expect(customElements.get(TAG), `${TAG} is defined by registerComponents()`).toBeDefined()
    const client = setupMockClient() as unknown as Client
    const sent: Array<{ kind: string; variantId: string }> = []
    installAlerts(client, async (input) => {
      sent.push(input as { kind: string; variantId: string })
      return { status: 'pending' }
    })
    select(client, [{ id: 'v0', stock: 0 }], 'v0')
    const el = await mount({ 'product-id': 'p1', 'variant-id': 'v0', stock: '0' })
    const submit = () => byTestId<HTMLButtonElement>(el, 'notify-me-submit')
    const state = () => ({
      kind: shownForm(el)?.kind ?? null,
      disabled: find<HTMLButtonElement>(el, 'notify-me-submit')?.disabled ?? null,
      notice: shownText(el, 'notify-me-notice'),
    })

    type(el, 'ada@example.test')
    submit().click()
    await flush(el)
    expect(state(), 'out of stock, accepted').toEqual({
      kind: 'back_in_stock',
      disabled: true,
      notice: NOTICE,
    })

    select(client, [{ id: 'v0', stock: 3 }], 'v0')
    await flush(el)
    expect(state(), 'the same variant in stock').toEqual({
      kind: 'price_drop',
      disabled: false,
      notice: '',
    })
    type(el, 'ada@example.test')
    submit().click()
    await flush(el)
    expect(state(), 'in stock, accepted').toEqual({
      kind: 'price_drop',
      disabled: true,
      notice: NOTICE,
    })

    select(client, [{ id: 'v0', stock: 0 }], 'v0')
    await flush(el)
    expect(state(), 'out of stock again').toEqual({
      kind: 'back_in_stock',
      disabled: true,
      notice: NOTICE,
    })
    el.shadowRoot!.querySelector('form')!.requestSubmit()
    await flush(el)

    expect(sent.map((call) => [call.variantId, call.kind])).toEqual([
      ['v0', 'back_in_stock'],
      ['v0', 'price_drop'],
    ])
  })

  it('AC-8: property: k = 1-5 submits (clicks and requestSubmit()) while the call is held make one alerts.subscribe call; acceptance shows the notice and emits nymbal:alert:requested once with the kind and variant; a refusal shows notify-me-error, re-enables the form and emits nothing', async () => {
    expect(customElements.get(TAG), `${TAG} is defined by registerComponents()`).toBeDefined()
    await fc.assert(
      fc.asyncProperty(
        email,
        fc.integer({ min: 1, max: 5 }),
        fc.boolean(),
        fc.stringMatching(/^[A-Z][a-z]{3,10} refused$/),
        async (address, k, succeeds, message) => {
          document.body.innerHTML = ''
          const held = deferred()
          const client = setupMockClient() as unknown as Client
          const subscribe = vi.fn(async () => {
            await held.promise
            return { status: 'pending' }
          })
          installAlerts(client, subscribe)
          const events: unknown[] = []
          const listener = (e: Event): void => {
            events.push((e as CustomEvent).detail)
          }
          document.addEventListener(EVENT, listener)
          try {
            const el = await mount({ 'product-id': 'p9', 'variant-id': 'v9', stock: '0' })
            type(el, address)
            const button = byTestId<HTMLButtonElement>(el, 'notify-me-submit')
            const form = button.closest('form')!
            for (let i = 0; i < k; i += 1) {
              if (i % 2 === 0) button.click()
              else form.requestSubmit()
            }
            await flush(el)

            expect(subscribe.mock.calls, `${k} submits while held`).toEqual([
              [{ email: address, variantId: 'v9', kind: 'back_in_stock' }],
            ])
            expect(byTestId<HTMLButtonElement>(el, 'notify-me-submit').disabled).toBe(true)

            if (succeeds) held.resolve()
            else held.reject(new Error(message))
            await flush(el)

            expect({
              notice: shownText(el, 'notify-me-notice'),
              error: shownText(el, 'notify-me-error') !== '',
              events,
            }).toEqual(
              succeeds
                ? {
                    notice: NOTICE,
                    error: false,
                    events: [{ kind: 'back_in_stock', variantId: 'v9' }],
                  }
                : { notice: '', error: true, events: [] },
            )
            // A refusal re-enables the form for another try.
            expect(succeeds || !byTestId<HTMLButtonElement>(el, 'notify-me-submit').disabled).toBe(
              true,
            )
            expect(subscribe).toHaveBeenCalledTimes(1)
          } finally {
            document.removeEventListener(EVENT, listener)
          }
        },
      ),
      { numRuns: 25 },
    )
  })
})
