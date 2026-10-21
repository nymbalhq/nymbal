import fc from 'fast-check'
import { describe, it, expect, beforeEach } from 'vitest'
import { setupMockClient } from '../testing/index.js'

beforeEach(() => {
  setupMockClient()
})

function createElement(attrs: Record<string, string> = {}): HTMLElement {
  const el = document.createElement('nymbal-quantity-selector')
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  document.body.appendChild(el)
  return el
}

describe('nymbal-quantity-selector', () => {
  it('renders decrement, input, and increment controls', () => {
    const el = createElement({ 'variant-id': 'v1', value: '2' })
    expect(el.querySelector('[data-testid="qty-decrement"]')).toBeTruthy()
    expect(el.querySelector('[data-testid="qty-input"]')).toBeTruthy()
    expect(el.querySelector('[data-testid="qty-increment"]')).toBeTruthy()
  })

  it('displays the correct initial value', () => {
    const el = createElement({ 'variant-id': 'v1', value: '3' })
    const input = el.querySelector('[data-testid="qty-input"]') as HTMLInputElement
    expect(input.value).toBe('3')
  })

  it('decrement button decreases quantity', async () => {
    const el = createElement({ 'variant-id': 'v1', value: '3' })
    const dec = el.querySelector('[data-testid="qty-decrement"]') as HTMLButtonElement
    dec.click()
    await Promise.resolve()
    const input = el.querySelector('[data-testid="qty-input"]') as HTMLInputElement
    expect(Number(input.value)).toBeLessThan(3)
  })

  it('increment button increases quantity', async () => {
    const el = createElement({ 'variant-id': 'v1', value: '1' })
    const inc = el.querySelector('[data-testid="qty-increment"]') as HTMLButtonElement
    inc.click()
    await Promise.resolve()
    const input = el.querySelector('[data-testid="qty-input"]') as HTMLInputElement
    expect(Number(input.value)).toBeGreaterThan(1)
  })

  it('decrement is disabled at min value', () => {
    const el = createElement({ 'variant-id': 'v1', value: '1', min: '1' })
    const dec = el.querySelector('[data-testid="qty-decrement"]') as HTMLButtonElement
    expect(dec.disabled).toBe(true)
  })

  // Add-to-cart adds what the selector emits, so the shopper gets the quantity shown only when the two are the same.
  it('for any typed value, the value shown after the change equals the one emitted: the typed number truncated toward zero, clamped to 1-99, and 1 when it is not a number', () => {
    const typed = fc.oneof(
      fc.constantFrom('2.7', '0', '-5', '150', '1e2', '99.9', '-0.5', '0.9', 'abc', '', ' '),
      fc.integer({ min: -1000, max: 1000 }).map(String),
      fc.double({ min: -500, max: 500, noNaN: true }).map(String),
      fc.string(),
    )
    fc.assert(
      fc.property(typed, (raw) => {
        document.body.innerHTML = ''
        const el = createElement({ value: '1', min: '1', max: '99' })
        const emitted: unknown[] = []
        el.addEventListener('nymbal:quantity:changed', (e) =>
          emitted.push((e as CustomEvent<{ value: unknown }>).detail.value),
        )
        const input = el.querySelector('[data-testid="qty-input"]') as HTMLInputElement
        input.value = raw
        // A number input holds what the browser kept of the typing; that is all the element can read.
        const n = Number(input.value)
        const expected =
          input.value.trim() === '' || Number.isNaN(n) ? 1 : Math.min(99, Math.max(1, Math.trunc(n)))
        input.dispatchEvent(new Event('change'))

        const shown = (el.querySelector('[data-testid="qty-input"]') as HTMLInputElement).value
        expect(emitted).toEqual([Number(shown)])
        expect(shown).toBe(String(expected))
        expect(Number.isInteger(Number(shown))).toBe(true)
      }),
      { numRuns: 300 },
    )
  })
})
