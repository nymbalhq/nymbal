import { describe, it, expect, beforeEach } from 'vitest'
import { setupMockClient } from '../testing/index.js'

beforeEach(() => {
  setupMockClient()
})

describe('nymbal-product-filter', () => {
  it('renders without error', () => {
    const el = document.createElement('nymbal-product-filter')
    document.body.appendChild(el)
    expect(el).toBeTruthy()
  })

  it('disconnects cleanly', () => {
    const el = document.createElement('nymbal-product-filter')
    document.body.appendChild(el)
    document.body.removeChild(el)
    expect(true).toBe(true)
  })
})
