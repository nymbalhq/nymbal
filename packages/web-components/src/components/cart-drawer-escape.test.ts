import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setupMockClient } from '../testing/index.js'

// The cart drawer closes on Escape: an open drawer's overlay covers the page, so without a key to close it the
// shopper's next click (Add to Cart again) lands on the overlay. Escape closes only through `hide()`, so the
// `nymbal:cart:close` event every wrapper follows is sent once per close.

type Drawer = HTMLElement & {
  show(): void
  updateComplete: Promise<unknown>
}

let closes = 0
const onClose = (): void => {
  closes += 1
}

beforeEach(() => {
  setupMockClient()
  closes = 0
  window.addEventListener('nymbal:cart:close', onClose)
})

afterEach(() => {
  window.removeEventListener('nymbal:cart:close', onClose)
})

async function mount(): Promise<Drawer> {
  const drawer = document.createElement('nymbal-cart-drawer') as Drawer
  document.body.appendChild(drawer)
  await drawer.updateComplete
  return drawer
}

/** A key press as the browser raises it: on the focused node, bubbling, and out of any shadow root. */
function press(target: EventTarget, key: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true }))
}

/** A node inside the drawer's own shadow root, where focus sits after the shopper tabs into the panel. */
function insideDrawer(drawer: Drawer): Element {
  const node = drawer.shadowRoot?.querySelector('[data-testid="cart-drawer-close"]')
  if (node == null) throw new Error('the drawer rendered no close button')
  return node
}

type Origin = 'document' | 'page' | 'shadow'

type Step =
  | { kind: 'show' }
  | { kind: 'key'; key: string; from: Origin }
  | { kind: 'disconnect' }
  | { kind: 'connect' }

const step: fc.Arbitrary<Step> = fc.oneof(
  fc.constant<Step>({ kind: 'show' }),
  fc.record({
    kind: fc.constant('key' as const),
    key: fc.constantFrom('Escape', 'Enter', 'a', 'Tab', ' '),
    from: fc.constantFrom<Origin>('document', 'page', 'shadow'),
  }),
  fc.constant<Step>({ kind: 'disconnect' }),
  fc.constant<Step>({ kind: 'connect' }),
)

describe('nymbal-cart-drawer and the Escape key', () => {
  it('AC-1: an open drawer closes on Escape pressed on the document, on a page field or inside its own shadow root: open is removed and window gets exactly one nymbal:cart:close', async () => {
    for (const from of ['document', 'page', 'shadow'] as const) {
      document.body.innerHTML = ''
      const field = document.createElement('input')
      document.body.appendChild(field)
      const drawer = await mount()
      drawer.show()
      const before = closes

      press(
        from === 'document' ? document : from === 'page' ? field : insideDrawer(drawer),
        'Escape',
      )

      expect(drawer.hasAttribute('open'), `Escape from ${from}`).toBe(false)
      expect(closes - before, `close events for one Escape from ${from}`).toBe(1)
    }
  })

  it('AC-1: property: over any sequence of opening, key presses from anywhere, disconnecting and reconnecting, the drawer is open exactly when the model says and has sent one close per Escape that found it open and connected', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 12 }), async (steps) => {
        document.body.innerHTML = ''
        closes = 0
        const field = document.createElement('input')
        document.body.appendChild(field)
        const drawer = await mount()
        const model = { open: false, connected: true, closes: 0 }

        for (const s of steps) {
          if (s.kind === 'show') {
            if (!model.connected) continue
            drawer.show()
            model.open = true
          } else if (s.kind === 'disconnect') {
            if (!model.connected) continue
            drawer.remove()
            model.connected = false
          } else if (s.kind === 'connect') {
            if (model.connected) continue
            document.body.appendChild(drawer)
            await drawer.updateComplete
            model.connected = true
          } else {
            // A detached drawer has no focusable node a page key reaches: its own presses come from the document.
            const target =
              s.from === 'document' || !model.connected
                ? document
                : s.from === 'page'
                  ? field
                  : insideDrawer(drawer)
            press(target, s.key)
            if (s.key === 'Escape' && model.open && model.connected) {
              model.open = false
              model.closes += 1
            }
          }
          expect(drawer.hasAttribute('open'), JSON.stringify(steps)).toBe(model.open)
          expect(closes, JSON.stringify(steps)).toBe(model.closes)
        }
      }),
      { numRuns: 60 },
    )
  })
})
