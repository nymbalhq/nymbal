import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { NymbalProvider, useNymbalClient } from './context.js'
import type { NymbalClient } from '@nymbal/sdk'

const mockClient = { cart: { getState: () => ({}), subscribe: () => () => {} } } as unknown as NymbalClient

function Consumer() {
  const client = useNymbalClient()
  return <div data-testid="client">{client ? 'connected' : 'missing'}</div>
}

describe('NymbalProvider + useNymbalClient', () => {
  it('provides client to children', () => {
    render(
      <NymbalProvider client={mockClient}>
        <Consumer />
      </NymbalProvider>,
    )
    expect(screen.getByTestId('client').textContent).toBe('connected')
  })

  it('useNymbalClient throws when used outside provider', () => {
    const originalError = console.error
    console.error = () => {}
    expect(() => render(<Consumer />)).toThrow()
    console.error = originalError
  })
})
