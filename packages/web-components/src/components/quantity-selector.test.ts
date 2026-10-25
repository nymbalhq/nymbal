import fc from 'fast-check'
import { describe, it, expect, beforeEach } from 'vitest'
import { setupMockClient } from '../testing/index.js'

// The element is a Lit element that renders in an open shadow root, so its internals are read through `shadowRoot`,
// once its render has settled (`updateComplete`).

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

async function createElement(attrs: Record<string, string> = {}): Promise<HTMLElement> {
  const el = document.createElement('nymbal-quantity-selector')
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  document.body.appendChild(el)
  await settled(el)
  return el
}

const part = <T extends Element>(el: HTMLElement, testid: string): T =>
  shadow(el).querySelector(`[data-testid="${testid}"]`) as T

describe('nymbal-quantity-selector', () => {
  it('displays the correct initial value', async () => {
    const el = await createElement({ 'variant-id': 'v1', value: '3' })
    const input = part<HTMLInputElement>(el, 'qty-input')
    expect(input.value).toBe('3')
  })

  it('decrement button decreases quantity', async () => {
    const el = await createElement({ 'variant-id': 'v1', value: '3' })
    part<HTMLButtonElement>(el, 'qty-decrement').click()
    await settled(el)
    const input = part<HTMLInputElement>(el, 'qty-input')
    expect(Number(input.value)).toBeLessThan(3)
  })

  it('increment button increases quantity', async () => {
    const el = await createElement({ 'variant-id': 'v1', value: '1' })
    part<HTMLButtonElement>(el, 'qty-increment').click()
    await settled(el)
    const input = part<HTMLInputElement>(el, 'qty-input')
    expect(Number(input.value)).toBeGreaterThan(1)
  })

  it('decrement is disabled at min value', async () => {
    const el = await createElement({ 'variant-id': 'v1', value: '1', min: '1' })
    const dec = part<HTMLButtonElement>(el, 'qty-decrement')
    expect(dec.disabled).toBe(true)
  })

  // Add-to-cart adds what the selector emits, so the shopper gets the quantity shown only when the two are the same.
  it('for any typed value, the value shown after the change equals the one emitted: the typed number truncated toward zero, clamped to 1-99, and 1 when it is not a number', async () => {
    const typed = fc.oneof(
      fc.constantFrom('2.7', '0', '-5', '150', '1e2', '99.9', '-0.5', '0.9', 'abc', '', ' '),
      fc.integer({ min: -1000, max: 1000 }).map(String),
      fc.double({ min: -500, max: 500, noNaN: true }).map(String),
      fc.string(),
    )
    await fc.assert(
      fc.asyncProperty(typed, async (raw) => {
        document.body.innerHTML = ''
        const el = await createElement({ value: '1', min: '1', max: '99' })
        const emitted: unknown[] = []
        el.addEventListener('nymbal:quantity:changed', (e) =>
          emitted.push((e as CustomEvent<{ value: unknown }>).detail.value),
        )
        const input = part<HTMLInputElement>(el, 'qty-input')
        input.value = raw
        // A number input holds what the browser kept of the typing; that is all the element can read.
        const n = Number(input.value)
        const expected =
          input.value.trim() === '' || Number.isNaN(n)
            ? 1
            : Math.min(99, Math.max(1, Math.trunc(n)))
        input.dispatchEvent(new Event('change'))
        await settled(el)

        const shown = part<HTMLInputElement>(el, 'qty-input').value
        expect(emitted).toEqual([Number(shown)])
        expect(shown).toBe(String(expected))
        expect(Number.isInteger(Number(shown))).toBe(true)
      }),
      { numRuns: 300 },
    )
  })
})
