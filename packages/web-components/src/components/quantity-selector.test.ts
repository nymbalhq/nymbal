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
})
