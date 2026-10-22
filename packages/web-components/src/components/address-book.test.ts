import fc from 'fast-check'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NymbalClient } from '@nymbalhq/sdk'
import { setupMockClient } from '../testing/index.js'

// `nymbal-address-book` on the addresses page. Its add form's fields live in `nymbal-address-form`'s shadow root, so
// they have no form owner: Enter in one must still save the address, as it did when the fields were the page's own.
// Each saved address is badged "Default Shipping" and/or "Default Billing", as the Next page labelled them.
// Kills: Enter in a field doing nothing; a badge that does not say which default an address is.

const TAG = 'nymbal-address-book'

type Mock = ReturnType<typeof vi.fn>

let client: NymbalClient

beforeEach(() => {
  client = setupMockClient()
})

function installAddresses(list: unknown[], create: Mock): void {
  ;(client as unknown as Record<string, unknown>)['customer'] = {
    addresses: { list: vi.fn(async () => list), create, remove: vi.fn(async () => undefined) },
  }
}

async function settled(el: Element): Promise<void> {
  await (el as Element & { updateComplete?: Promise<unknown> }).updateComplete
}

async function flush(el: Element): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await settled(el)
    const nested = el.shadowRoot?.querySelector('nymbal-address-form')
    if (nested) await settled(nested)
  }
}

async function mount(): Promise<HTMLElement> {
  expect(customElements.get(TAG), `${TAG} is defined by registerComponents()`).toBeDefined()
  document.body.innerHTML = ''
  const el = document.createElement(TAG)
  document.body.appendChild(el)
  await flush(el)
  return el
}

function field(book: Element, id: string): HTMLInputElement {
  const form = book.shadowRoot?.querySelector('nymbal-address-form')
  const input = form?.shadowRoot?.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)
  if (!input) throw new Error(`no [data-testid="${id}"] in nymbal-address-form`)
  return input
}

const word = fc.stringMatching(/^[A-Z][a-z]{1,9}$/)

const ADDRESS = {
  id: 'addr-1',
  firstName: 'Ada',
  lastName: 'Lovelace',
  addressLine1: '1 Analytical Row',
  city: 'London',
  region: 'Greater London',
  postalCode: 'E1 6AN',
  country: 'GB',
}

describe('nymbal-address-book', () => {
  it('property: Enter in any add-address field saves the address once, with the fields typed', async () => {
    const names = [
      'firstName',
      'lastName',
      'addressLine1',
      'city',
      'region',
      'postalCode',
      'country',
    ] as const
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          firstName: word,
          lastName: word,
          addressLine1: word.map((w) => `1 ${w} Row`),
          city: word,
          region: word,
          postalCode: fc.stringMatching(/^E[1-9] [1-9]AN$/),
          country: fc.constantFrom('GB', 'FR'),
        }),
        fc.constantFrom(...names),
        async (address, pressedIn) => {
          client = setupMockClient()
          const create = vi.fn(async (a: Record<string, unknown>) => ({
            ...a,
            id: 'addr-new',
            isDefaultShipping: false,
            isDefaultBilling: false,
          }))
          installAddresses([], create)
          const book = await mount()
          for (const name of names) field(book, `new-address-${name}`).value = address[name]

          const key = new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            composed: true,
            cancelable: true,
          })
          field(book, `new-address-${pressedIn}`).dispatchEvent(key)
          await flush(book)

          expect(create, `Enter in ${pressedIn}`).toHaveBeenCalledTimes(1)
          expect(create.mock.calls[0]).toEqual([address])
        },
      ),
      { numRuns: 20 },
    )
  })

  it('a key other than Enter in a field saves nothing', async () => {
    const create = vi.fn(async () => ({
      ...ADDRESS,
      isDefaultShipping: false,
      isDefaultBilling: false,
    }))
    installAddresses([], create)
    const book = await mount()
    field(book, 'new-address-postalCode').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', bubbles: true, composed: true, cancelable: true }),
    )
    await flush(book)
    expect(create).not.toHaveBeenCalled()
  })

  it('property: each address is badged "Default Shipping" iff isDefaultShipping and "Default Billing" iff isDefaultBilling', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.boolean(), async (shipping, billing) => {
        client = setupMockClient()
        installAddresses(
          [{ ...ADDRESS, isDefaultShipping: shipping, isDefaultBilling: billing }],
          vi.fn(),
        )
        const book = await mount()
        const badges = [
          ...book.shadowRoot!.querySelectorAll(
            '[data-testid="address-addr-1"] [part~="address-badge"]',
          ),
        ].map((b) => b.textContent?.trim())
        expect(badges).toEqual([
          ...(shipping ? ['Default Shipping'] : []),
          ...(billing ? ['Default Billing'] : []),
        ])
      }),
      { numRuns: 8 },
    )
  })
})
