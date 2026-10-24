import fc from 'fast-check'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PRODUCT_SORT,
  PRODUCT_SORT_KEYS,
  PRODUCT_SORT_LABELS,
  type ProductSortKey,
} from '@nymbalhq/types'
import { setupMockClient } from '../testing/index.js'

// AC-4: <nymbal-sort-dropdown sort-keys='[…]' value> offers one option per key the store reports, in the report's
// order, labelled from PRODUCT_SORT_LABELS; a value the keys lack selects the default sort; choosing an option emits
// nymbal:sort:changed naming the key.
//
// The element is a Lit element with an open shadow root. A `<select>` slotted into its default slot (the Astro
// template's server render, so the sort works before JS) is the one it fills and wires; with none slotted it renders
// its own `<select part="select">` in the shadow root. Every AC-4 case runs in both shapes.

type Shape = 'slotted' | 'own'
const SHAPES: Shape[] = ['slotted', 'own']

beforeEach(() => {
  setupMockClient()
})

function shadow(el: Element): ShadowRoot {
  const root = el.shadowRoot
  if (root === null) throw new Error(`<${el.localName}> has no open shadow root`)
  return root
}

async function settled(el: Element): Promise<void> {
  await (el as Element & { updateComplete?: Promise<unknown> }).updateComplete
}

/** The `<select>` a server render puts inside the element. */
function serverSelect(): HTMLSelectElement {
  const select = document.createElement('select')
  select.setAttribute('aria-label', 'Sort products')
  select.setAttribute('data-testid', 'sort-dropdown')
  return select
}

async function mount(shape: Shape, keys: readonly string[], value: string): Promise<HTMLElement> {
  const el = document.createElement('nymbal-sort-dropdown')
  if (shape === 'slotted') el.appendChild(serverSelect())
  el.setAttribute('sort-keys', JSON.stringify(keys))
  el.setAttribute('value', value)
  // The report's defaultSort, for an element that takes it from an attribute; the native default otherwise.
  el.setAttribute('default-sort', DEFAULT_PRODUCT_SORT)
  document.body.appendChild(el)
  await settled(el)
  return el
}

/** The select the shopper uses: the slotted one, or the element's own `part="select"` in its shadow root. */
function selectOf(el: HTMLElement, shape: Shape): HTMLSelectElement {
  const root = shadow(el)
  const select =
    shape === 'slotted'
      ? ([...el.children].find((c): c is HTMLSelectElement => c instanceof HTMLSelectElement) ??
        null)
      : root.querySelector<HTMLSelectElement>('select[part~="select"]')
  if (select === null) throw new Error(`nymbal-sort-dropdown (${shape}) has no <select>`)
  return select
}

const arbKeys = fc.shuffledSubarray([...PRODUCT_SORT_KEYS], { minLength: 1 })

describe('nymbal-sort-dropdown: decision 3a', () => {
  it('a slotted <select> is assigned to the default slot, and the shadow root renders no <select> of its own', async () => {
    const keys = [...PRODUCT_SORT_KEYS]
    const el = await mount('slotted', keys, DEFAULT_PRODUCT_SORT)
    const slotted =
      [...el.children].find((c): c is HTMLSelectElement => c instanceof HTMLSelectElement) ?? null
    const slot = shadow(el).querySelector<HTMLSlotElement>('slot:not([name])')

    expect(slot?.assignedElements()).toContain(slotted)
    expect(shadow(el).querySelectorAll('select')).toHaveLength(0)
    expect(el.querySelectorAll('select')).toHaveLength(1)
  })

  it('with no slotted <select>, the shadow root renders one <select part="select"> and the light DOM gets none', async () => {
    const keys = [...PRODUCT_SORT_KEYS]
    const el = await mount('own', keys, DEFAULT_PRODUCT_SORT)

    expect(shadow(el).querySelectorAll('select[part~="select"]')).toHaveLength(1)
    expect(el.querySelectorAll('select')).toHaveLength(0)
    expect([...selectOf(el, 'own').options].map((o) => o.value)).toEqual(keys)
  })
})

describe.each(SHAPES)('nymbal-sort-dropdown (%s select)', (shape) => {
  it('AC-4: over generated subsets and orders of sortKeys, the options are exactly the keys in that order, labelled from PRODUCT_SORT_LABELS, with value selected', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbKeys.chain((keys) => fc.tuple(fc.constant(keys), fc.constantFrom(...keys))),
        async ([keys, value]) => {
          const el = await mount(shape, keys, value)
          try {
            const options = [...selectOf(el, shape).options]

            expect(options.map((o) => o.value)).toEqual(keys)
            expect(options.map((o) => o.textContent?.trim())).toEqual(
              keys.map((k) => PRODUCT_SORT_LABELS[k]),
            )
            expect(selectOf(el, shape).value).toBe(value)
          } finally {
            el.remove()
          }
        },
      ),
      { numRuns: 60 },
    )
  })

  it('AC-4: over generated key sets holding the default and values outside them, the default sort is selected', async () => {
    const arbWithDefault = fc
      .shuffledSubarray(
        PRODUCT_SORT_KEYS.filter((k) => k !== DEFAULT_PRODUCT_SORT),
        { minLength: 0 },
      )
      .chain((rest) =>
        fc
          .integer({ min: 0, max: rest.length })
          .map((at) => [...rest.slice(0, at), DEFAULT_PRODUCT_SORT, ...rest.slice(at)]),
      )
    await fc.assert(
      fc.asyncProperty(
        arbWithDefault,
        fc
          .string({ maxLength: 12 })
          .filter((v) => !(PRODUCT_SORT_KEYS as readonly string[]).includes(v)),
        async (keys, unknown) => {
          const el = await mount(shape, keys, unknown)
          try {
            expect(selectOf(el, shape).value).toBe(DEFAULT_PRODUCT_SORT)
            expect([...selectOf(el, shape).options].map((o) => o.value)).toEqual(keys)
          } finally {
            el.remove()
          }
        },
      ),
      { numRuns: 60 },
    )
  })

  it('AC-4: a key outside the report is never offered, even as the value', async () => {
    const keys: ProductSortKey[] = ['price-asc', 'newest']
    const el = await mount(shape, keys, 'name-desc')

    expect([...selectOf(el, shape).options].map((o) => o.value)).toEqual(keys)
    expect(selectOf(el, shape).value).toBe(DEFAULT_PRODUCT_SORT)
  })

  it('AC-4: choosing each offered option emits one bubbling nymbal:sort:changed naming that key', async () => {
    const keys = [...PRODUCT_SORT_KEYS].reverse()
    const el = await mount(shape, keys, DEFAULT_PRODUCT_SORT)
    const seen: unknown[] = []
    document.body.addEventListener('nymbal:sort:changed', (e) => {
      seen.push((e as CustomEvent).detail)
    })
    const select = selectOf(el, shape)

    for (const key of keys) {
      select.value = key
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await settled(el)
    }

    expect(seen).toHaveLength(keys.length)
    expect(
      seen.map((detail) =>
        keys.find((k) => Object.values((detail ?? {}) as Record<string, unknown>).includes(k)),
      ),
    ).toEqual(keys)
  })
})
