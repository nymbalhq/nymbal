import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DenormalisedProduct, NymbalClient } from '@nymbalhq/sdk'
import type { VariantOption } from '@nymbalhq/types'
import { createMockClient, type createMockStore } from '../testing/index.js'
import { registerClient } from '../registry.js'

// AC-5 (the selector): <nymbal-variant-selector> takes variant options as `VariantOption[]` only. Given variants whose
// options are strings (JSON or not), it renders no option and logs nothing, so no parse is attempted; given a
// JSON-string `options` attribute, it does not read it: the options shown are exactly the variants' own.

const LOGS = ['log', 'info', 'debug', 'warn', 'error'] as const

let logs: Array<ReturnType<typeof vi.spyOn>>

beforeEach(() => {
  logs = LOGS.map((level) => vi.spyOn(console, level).mockImplementation(() => undefined))
})

afterEach(() => {
  vi.restoreAllMocks()
})

function productWith(variantOptions: unknown[]): DenormalisedProduct {
  return {
    id: 'prod-variants',
    slug: 'one-shape',
    name: 'One Shape',
    description: '',
    shortDescription: '',
    status: 'active',
    type: 'variable',
    media: [],
    variantCount: variantOptions.length,
    inStock: true,
    priceRange: null,
    currency: 'GBP',
    priceMinor: 1000,
    categoryIds: [],
    categories: [],
    createdAt: '',
    updatedAt: '',
    variants: variantOptions.map((options, i) => ({
      id: `var-${i}`,
      sku: `SKU-${i}`,
      name: `Variant ${i}`,
      priceMinor: 1000 + i,
      stock: 5,
      options: options as VariantOption[],
    })),
  } as unknown as DenormalisedProduct
}

// The element is a Lit element that renders in an open shadow root, so its options are read through `shadowRoot`,
// once its render has settled (`updateComplete`).
function shadow(el: Element): ShadowRoot {
  const root = el.shadowRoot
  if (root === null) throw new Error(`<${el.localName}> has no open shadow root`)
  return root
}

async function settled(el: Element): Promise<void> {
  await (el as Element & { updateComplete?: Promise<unknown> }).updateComplete
}

async function mountSelector(
  product: DenormalisedProduct,
  optionsAttr?: string,
): Promise<HTMLElement> {
  const client: NymbalClient = createMockClient()
  ;(client.product as unknown as ReturnType<typeof createMockStore>).setState({
    product,
    selectedVariant: null,
    loading: false,
    error: null,
  })
  registerClient(client)
  const el = document.createElement('nymbal-variant-selector')
  if (optionsAttr !== undefined) el.setAttribute('options', optionsAttr)
  document.body.appendChild(el)
  await settled(el)
  return el
}

const shownOptions = (el: HTMLElement): string[] =>
  [...shadow(el).querySelectorAll<HTMLElement>('[data-testid^="variant-option-"]')]
    .map((b) => b.dataset.testid!)
    .sort()

/** The testids the variants' own options call for: one per distinct name and value. */
const optionTestids = (options: VariantOption[][]): string[] =>
  [...new Set(options.flat().map((o) => `variant-option-${o.name}-${o.value}`))].sort()

const arbOptionList: fc.Arbitrary<VariantOption[]> = fc.uniqueArray(
  fc.record({
    name: fc.constantFrom('Size', 'Colour', 'Fit'),
    value: fc.stringMatching(/^[A-Za-z0-9]{1,6}$/),
  }),
  { minLength: 1, maxLength: 3, selector: (o) => o.name },
)

describe('the variant selector takes one option shape', () => {
  it('AC-5: variants whose options are strings, JSON or not, render no option and log nothing', async () => {
    const arbStringOptions = fc.oneof(
      arbOptionList.map((o) => JSON.stringify(o)),
      fc.string(),
    )
    await fc.assert(
      fc.asyncProperty(fc.array(arbStringOptions, { minLength: 2, maxLength: 4 }), async (raw) => {
        const el = await mountSelector(productWith(raw))

        expect(shownOptions(el)).toEqual([])
        for (const log of logs) expect(log.mock.calls).toEqual([])
        el.remove()
      }),
      { numRuns: 100 },
    )
  })

  it('AC-5: a JSON-string options attribute is not read: the options shown are exactly the variants’ own', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbOptionList, { minLength: 2, maxLength: 4 }),
        fc.stringMatching(/^[A-Za-z]{1,6}$/),
        async (options, extra) => {
          // The attribute claims a value no variant has, in a group of its own and in each of the variants' groups.
          const groups = [...new Set(options.flat().map((o) => o.name))]
          const attr = JSON.stringify([
            { name: 'Attr', values: [extra] },
            ...groups.map((name) => ({ name, values: [`${extra}x`] })),
          ])
          const el = await mountSelector(productWith(options), attr)

          expect(shownOptions(el)).toEqual(optionTestids(options))
          el.remove()
        },
      ),
      { numRuns: 100 },
    )
  })
})
