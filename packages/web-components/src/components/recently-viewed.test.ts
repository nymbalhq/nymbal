import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setupMockClient } from '../testing/index.js'
import { renderElement } from '../ssr/index.js'

// AC-11: `nymbal-recently-viewed` against a fake `client.recentlyViewed`. One page view is one record, then one list:
// a `current` set in the frame the element connects in is recorded before the first read, and a re-render, a `limit`
// change or a reconnect calls nothing more; each new `current` is recorded, then the list read again. It shows the
// listed products less `current`, the first `limit` (4 when unset or not a positive integer), as non-eager cards in
// `grid` under the heading, and nothing at all when nothing is left or the read fails. `loaded` fires once per read
// with the ids shown. Without a client it renders nothing and the server render is an empty template.

const TAG = 'nymbal-recently-viewed'
const LOADED = 'nymbal:recently-viewed:loaded'
const PARTS = ['grid', 'heading', 'section']

interface Listed {
  id: string
  slug: string
  name: string
  priceMinor: number
  currency: string
  media: never[]
}

const product = (letter: string): Listed => ({
  id: `p-${letter}`,
  slug: `slug-${letter}`,
  name: `Product ${letter.toUpperCase()}`,
  priceMinor: 1200,
  currency: 'GBP',
  media: [],
})

const [A, B, C] = [product('a'), product('b'), product('c')]
const CATALOGUE = 'abcdefghij'.split('').map(product)

interface Fake {
  /** Every call the element made, in order: `record:<id>` or `list`. */
  calls: string[]
  /** Every `loaded` detail, in order. */
  loaded: string[][]
}

/** Registers a mock client whose `recentlyViewed` answers `items` (or rejects), and records what the element asks. */
function fakeClient(answer: Listed[] | 'fail'): Fake {
  const fake: Fake = { calls: [], loaded: [] }
  const client = setupMockClient() as unknown as Record<string, unknown>
  client['recentlyViewed'] = {
    record: async (productId: string) => {
      fake.calls.push(`record:${productId}`)
    },
    list: async () => {
      fake.calls.push('list')
      if (answer === 'fail') throw new Error('Unavailable')
      return { items: answer }
    },
  }
  const listener = (e: Event): void => {
    fake.loaded.push([...((e as CustomEvent<{ productIds: string[] }>).detail.productIds ?? [])])
  }
  // One fake listens at a time: a property run replaces the last run's.
  for (const old of listeners.splice(0)) document.removeEventListener(LOADED, old)
  listeners.push(listener)
  document.addEventListener(LOADED, listener)
  return fake
}

const listeners: Array<(e: Event) => void> = []

/** Lets the element's update, its record and its read run to the end. */
async function settle(el: HTMLElement): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await (el as unknown as { updateComplete?: Promise<unknown> }).updateComplete
  }
}

/** Connects the element, then sets its attributes in the same frame, as a wrapper's effect does after connect. */
async function mount(attrs: Record<string, string> = {}): Promise<HTMLElement> {
  const el = document.createElement(TAG)
  document.body.append(el)
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value)
  await settle(el)
  return el
}

function partsOf(el: HTMLElement): string[] {
  const root: ParentNode = el.shadowRoot ?? el
  return [
    ...new Set(
      [...root.querySelectorAll('[part]')].flatMap((n) =>
        (n.getAttribute('part') ?? '').split(/\s+/).filter((p) => p !== ''),
      ),
    ),
  ].sort()
}

/** The cards in `grid`, in order: each one's slug as it renders it, and whether it is eager. */
async function cards(el: HTMLElement): Promise<Array<{ slug: string; eager: boolean }>> {
  const grid = el.shadowRoot?.querySelector('[part~="grid"]')
  const found = [...(grid?.querySelectorAll('nymbal-product-card') ?? [])] as HTMLElement[]
  const out: Array<{ slug: string; eager: boolean }> = []
  for (const card of found) {
    await (card as unknown as { updateComplete?: Promise<unknown> }).updateComplete
    const testid =
      card.shadowRoot
        ?.querySelector('[data-testid^="product-card-"]')
        ?.getAttribute('data-testid') ?? ''
    out.push({ slug: testid.slice('product-card-'.length), eager: card.hasAttribute('eager') })
  }
  return out
}

const shownSlugs = async (el: HTMLElement): Promise<string[]> =>
  (await cards(el)).map((c) => c.slug)

const unhandled: unknown[] = []
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason)
}

beforeEach(() => {
  unhandled.length = 0
  process.on('unhandledRejection', onUnhandled)
})

afterEach(() => {
  process.off('unhandledRejection', onUnhandled)
  for (const old of listeners.splice(0)) document.removeEventListener(LOADED, old)
})

describe('AC-11(a): one page view is one record, then one list', () => {
  it('AC-11(a): connected, then current set in the same frame: exactly record(current), then one list(), in that order', async () => {
    const fake = fakeClient([B, A])
    await mount({ current: B.id })
    expect(fake.calls).toEqual([`record:${B.id}`, 'list'])
  })

  it('AC-11(a): connected with no current: one list() and no record', async () => {
    const fake = fakeClient([A])
    await mount()
    expect(fake.calls).toEqual(['list'])
  })

  it('AC-11(a): property: after the first read, a re-render, a limit change and a disconnect and reconnect call nothing more; each new current adds one record, then one list', async () => {
    type Step =
      | { kind: 'render' }
      | { kind: 'limit'; value: number }
      | { kind: 'reconnect' }
      | { kind: 'navigate' }
    const step: fc.Arbitrary<Step> = fc.oneof(
      fc.constant({ kind: 'render' as const }),
      fc.integer({ min: -1, max: 6 }).map((value) => ({ kind: 'limit' as const, value })),
      fc.constant({ kind: 'reconnect' as const }),
      fc.constant({ kind: 'navigate' as const }),
    )
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.array(step, { maxLength: 8 }),
        async (withCurrent, steps) => {
          document.body.innerHTML = ''
          const fake = fakeClient(CATALOGUE)
          const fresh = [...CATALOGUE]
          const first = withCurrent ? fresh.shift()! : undefined
          const el = await mount(first === undefined ? {} : { current: first.id })
          const expected = first === undefined ? ['list'] : [`record:${first.id}`, 'list']
          expect(fake.calls).toEqual(expected)

          for (const s of steps) {
            if (s.kind === 'render') {
              ;(el as unknown as { requestUpdate(): void }).requestUpdate()
            } else if (s.kind === 'limit') {
              el.setAttribute('limit', String(s.value))
            } else if (s.kind === 'reconnect') {
              el.remove()
              document.body.append(el)
            } else {
              const next = fresh.shift()
              if (next === undefined) continue
              el.setAttribute('current', next.id)
              expected.push(`record:${next.id}`, 'list')
            }
            await settle(el)
            expect(fake.calls, `after ${s.kind}`).toEqual(expected)
          }
          expect(fake.calls.filter((c) => c === 'list').length).toBe(
            fake.calls.filter((c) => c.startsWith('record:')).length +
              (first === undefined ? 1 : 0),
          )
        },
      ),
      { numRuns: 40 },
    )
  })
})

describe('AC-11(b): without a client', () => {
  it('AC-11(b): with no client registered it renders no part and nothing throws, and renderElement gives an empty template', async () => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('nymbal.client')]
    const errors: string[] = []
    const onError = (e: ErrorEvent): void => {
      errors.push(String(e.error ?? e.message))
    }
    window.addEventListener('error', onError)
    try {
      const el = await mount({ current: A.id, limit: '2' })
      expect(partsOf(el)).toEqual([])
    } finally {
      window.removeEventListener('error', onError)
    }
    expect(errors).toEqual([])
    expect(unhandled).toEqual([])

    const html = renderElement(TAG, { attributes: { current: A.id } })
    const host = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body
      .firstElementChild!
    expect(host.localName).toBe(TAG)
    const template = host.querySelector(
      'template[shadowrootmode="open"]',
    ) as HTMLTemplateElement | null
    expect(
      template?.content.querySelectorAll('[part]').length ?? -1,
      'parts in the server render',
    ).toBe(0)
    expect(template?.content.querySelectorAll('nymbal-product-card').length ?? -1).toBe(0)
  })
})

describe('AC-11(c): what it shows', () => {
  it('AC-11(c): listed A, B, C with current B and no limit shows cards A, C in that order; with limit=1, A', async () => {
    fakeClient([A, B, C])
    const el = await mount({ current: B.id })
    expect(await shownSlugs(el)).toEqual([A.slug, C.slug])

    document.body.innerHTML = ''
    fakeClient([A, B, C])
    const one = await mount({ current: B.id, limit: '1' })
    expect(await shownSlugs(one)).toEqual([A.slug])
  })

  it('AC-11(c): property: it shows the listed products less current, in the listed order, the first limit of them (4 when limit is unset or not a positive integer), as non-eager cards under the heading', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray(CATALOGUE, { maxLength: 9 }),
        fc.option(fc.nat({ max: 9 }), { nil: undefined }),
        fc.option(fc.oneof(fc.integer({ min: -2, max: 8 }).map(String), fc.constant('many')), {
          nil: undefined,
        }),
        async (listed, currentAt, limit) => {
          document.body.innerHTML = ''
          fakeClient(listed)
          const current = currentAt === undefined ? undefined : listed[currentAt]
          const el = await mount({
            ...(current !== undefined && { current: current.id }),
            ...(limit !== undefined && { limit }),
          })
          const n = Number(limit)
          const cap = limit !== undefined && Number.isInteger(n) && n > 0 ? n : 4
          const expected = listed.filter((p) => p.id !== current?.id).slice(0, cap)

          const shown = await cards(el)
          expect(shown.map((c) => c.slug)).toEqual(expected.map((p) => p.slug))
          expect(shown.filter((c) => c.eager)).toEqual([])
          const heading = el.shadowRoot?.querySelector('[part~="heading"]')
          expect(heading?.querySelector('slot[name="heading"]')?.textContent?.trim()).toBe(
            expected.length > 0 ? 'Recently viewed' : undefined,
          )
          expect(partsOf(el)).toEqual(expected.length > 0 ? PARTS : [])
        },
      ),
      { numRuns: 60 },
    )
  })
})

describe('AC-11(d): nothing to show', () => {
  it('AC-11(d): a list holding only current renders no part', async () => {
    const fake = fakeClient([B])
    const el = await mount({ current: B.id })
    expect(fake.calls).toEqual([`record:${B.id}`, 'list'])
    expect(partsOf(el)).toEqual([])
  })

  it('AC-11(d): list() rejecting renders no part and leaves no unhandled rejection', async () => {
    const fake = fakeClient('fail')
    const el = await mount({ current: A.id })
    expect(fake.calls).toEqual([`record:${A.id}`, 'list'])
    expect(partsOf(el)).toEqual([])
    expect(unhandled).toEqual([])
  })
})

describe('AC-11(e): the loaded event', () => {
  it('AC-11(e): nymbal:recently-viewed:loaded fires once per read with the ids shown', async () => {
    const fake = fakeClient([C, B, A])
    const el = await mount({ current: B.id, limit: '1' })
    expect(fake.loaded).toEqual([[C.id]])

    el.setAttribute('current', C.id)
    await settle(el)
    expect(fake.calls.filter((c) => c === 'list').length).toBe(fake.loaded.length)
    expect(fake.loaded).toEqual([[C.id], [B.id]])
  })

  it('AC-11(e): a read with nothing to show fires loaded once with no ids', async () => {
    const fake = fakeClient([])
    await mount()
    expect(fake.loaded).toEqual([[]])
  })
})

describe('AC-11(f): its parts', () => {
  it('AC-11(f): across empty, filled, failed and limited states it renders exactly section, heading and grid', async () => {
    const seen = new Set<string>()
    for (const [answer, attrs] of [
      [[], {}],
      [[A, B, C], {}],
      [[A, B, C], { current: A.id, limit: '1' }],
      ['fail', {}],
      [[B], { current: B.id }],
    ] as Array<[Listed[] | 'fail', Record<string, string>]>) {
      document.body.innerHTML = ''
      fakeClient(answer)
      for (const part of partsOf(await mount(attrs))) seen.add(part)
    }
    expect([...seen].sort()).toEqual(PARTS)
  })
})
