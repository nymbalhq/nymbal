import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import type { NymbalClient } from '@nymbalhq/sdk'
import { registerClient } from './registry.js'
import { createMockClient, type createMockStore } from './testing/index.js'

// Both templates run a project's elements entry before `registerClient`, so an element the project defines there (one
// extending a Nymbal element, upgraded at its `define`) connects with no client. Once `registerClient` runs, every
// element connected at that moment behaves as if it had connected after it: it follows its stores and runs the work
// its connect skipped for want of a client.

const CLIENT_KEY = Symbol.for('nymbal.client')

function clearClient(): void {
  delete (globalThis as Record<symbol, unknown>)[CLIENT_KEY]
}

/** A store that counts the subscriptions it holds. */
function countingStore() {
  let n = 0
  const live = new Set<{ fn: () => void }>()
  return {
    subscribe(fn: () => void): () => void {
      const token = { fn }
      live.add(token)
      return () => {
        live.delete(token)
      }
    },
    getState: () => ({ n, loading: false }),
    bump(): void {
      n += 1
      for (const token of [...live]) token.fn()
    },
    get held(): number {
      return live.size
    },
  }
}

type CountingStore = ReturnType<typeof countingStore>
type Counting = HTMLElement & { updateComplete: Promise<unknown> }

/**
 * Lets every pending microtask, timer and render settle. Only connected elements are awaited: one never connected
 * has an update pending that resolves only once it connects.
 */
async function flush(elements: Counting[]): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await Promise.all(elements.filter((el) => el.isConnected).map((el) => el.updateComplete))
  }
}

let tags = 0

describe('registerClient after elements connected', () => {
  it('AC-8: property: for any interleaving of connecting and disconnecting elements, each naming one to three stores, with one registerClient at any point, each connected element then holds exactly one subscription per store it names and re-renders from it, and each disconnected one holds none', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 1, maxLength: 4 }),
        fc.array(fc.record({ el: fc.nat(), connect: fc.boolean() }), { maxLength: 12 }),
        fc.nat(),
        async (storesPerElement, ops, at) => {
          // A registry no client was registered with, and the base class bound to it.
          vi.resetModules()
          clearClient()
          const { NymbalElement } = await import('./base-element.js')
          const registry = await import('./registry.js')

          const elements = storesPerElement.map((count) => {
            const named: CountingStore[] = Array.from({ length: count }, countingStore)
            const tag = `late-client-${++tags}`
            class CountingElement extends NymbalElement {
              protected override stores() {
                return named
              }
              protected override render() {
                return named.map((s) => s.getState().n).join(',')
              }
            }
            customElements.define(tag, CountingElement)
            return { el: document.createElement(tag) as Counting, named }
          })

          const registerAt = at % (ops.length + 1)
          const client = createMockClient()
          ops.forEach((op, i) => {
            if (i === registerAt) registry.registerClient(client)
            const { el } = elements[op.el % elements.length]!
            if (op.connect && !el.isConnected) document.body.appendChild(el)
            else if (!op.connect && el.isConnected) el.remove()
          })
          if (registerAt === ops.length) registry.registerClient(client)
          await flush(elements.map((e) => e.el))

          const trace = JSON.stringify({ storesPerElement, ops, registerAt })
          for (const { el, named } of elements) {
            expect(
              named.map((s) => s.held),
              `${el.localName} ${el.isConnected ? 'connected' : 'disconnected'}: ${trace}`,
            ).toEqual(named.map(() => (el.isConnected ? 1 : 0)))
          }

          for (const { named } of elements) for (const store of named) store.bump()
          await flush(elements.map((e) => e.el))
          for (const { el, named } of elements.filter((e) => e.el.isConnected)) {
            expect(
              el.shadowRoot?.textContent,
              `${el.localName} after a store change: ${trace}`,
            ).toBe(named.map((s) => s.getState().n).join(','))
          }
          document.body.innerHTML = ''
        },
      ),
      { numRuns: 60 },
    )
  }, 60_000)

  it('AC-9: an address book and a mini-cart connected before registerClient: once it runs, the book lists its addresses with one list call, and the mini-cart reads the cart once on a pageshow from the back/forward cache and shows its count', async () => {
    clearClient()
    const book = document.createElement('nymbal-address-book') as Counting
    const badge = document.createElement('nymbal-mini-cart') as Counting
    document.body.append(book, badge)
    await flush([book, badge])

    const addresses = [
      {
        id: 'addr-1',
        firstName: 'Ada',
        lastName: 'Lovelace',
        addressLine1: '1 Analytical Row',
        city: 'London',
        region: 'Greater London',
        postalCode: 'E1 6AN',
        country: 'GB',
      },
      {
        id: 'addr-2',
        firstName: 'Charles',
        lastName: 'Babbage',
        addressLine1: '2 Difference Lane',
        city: 'London',
        region: 'Greater London',
        postalCode: 'E2 7AB',
        country: 'GB',
      },
    ]
    const client: NymbalClient = createMockClient()
    const list = vi.fn(async () => addresses)
    ;(client as unknown as Record<string, unknown>)['customer'] = {
      addresses: { list, create: vi.fn(), remove: vi.fn() },
    }
    const cart = client.cart as unknown as ReturnType<typeof createMockStore<{ itemCount: number }>>
    const stored = 7
    let loads = 0
    client.cart.load = async () => {
      loads += 1
      cart.setState({ itemCount: stored })
    }
    const badgeBefore = badge.shadowRoot
      ?.querySelector('.nymbal-mini-cart-badge')
      ?.textContent?.trim()

    registerClient(client)
    await flush([book, badge])

    expect(list).toHaveBeenCalledTimes(1)
    expect(
      [...(book.shadowRoot?.querySelectorAll('[data-testid^="address-addr-"]') ?? [])].map((n) =>
        n.getAttribute('data-testid'),
      ),
    ).toEqual(addresses.map((a) => `address-${a.id}`))

    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
    await flush([book, badge])

    expect(loads, 'a restored page reads the cart once').toBe(1)
    const badgeAfter = badge.shadowRoot
      ?.querySelector('.nymbal-mini-cart-badge')
      ?.textContent?.trim()
    expect(badgeAfter).not.toBe(badgeBefore)
    expect(badgeAfter).toBe(String(stored))
  })

  it('an element whose connect work throws when registerClient runs is reported, and an element connected after it still follows its store', async () => {
    vi.resetModules()
    clearClient()
    const { NymbalElement } = await import('./base-element.js')
    const registry = await import('./registry.js')
    const failure = new Error('a project override threw')
    const reported: unknown[] = []
    // happy-dom has no `reportError`; the browsers that register a client do.
    vi.stubGlobal('reportError', (error: unknown) => {
      reported.push(error)
    })

    class ThrowingElement extends NymbalElement {
      protected override stores(): never {
        throw failure
      }
    }
    const good = countingStore()
    class GoodElement extends NymbalElement {
      protected override stores() {
        return [good]
      }
      protected override render() {
        return String(good.getState().n)
      }
    }
    const badTag = `late-client-${++tags}`
    const goodTag = `late-client-${++tags}`
    customElements.define(badTag, ThrowingElement)
    customElements.define(goodTag, GoodElement)
    const ok = document.createElement(goodTag) as Counting
    document.body.append(document.createElement(badTag), ok)

    try {
      expect(() => registry.registerClient(createMockClient())).not.toThrow()
      await flush([ok])
      expect(reported).toEqual([failure])
      expect(good.held, 'the element connected after the throwing one subscribed').toBe(1)
      good.bump()
      await flush([ok])
      expect(ok.shadowRoot?.textContent).toBe(String(good.getState().n))
    } finally {
      vi.unstubAllGlobals()
      document.body.innerHTML = ''
    }
  })
})
