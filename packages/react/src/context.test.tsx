import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { NymbalProvider, useNymbalClient } from './context.js'
import type { NymbalClient } from '@nymbalhq/sdk'

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

  // Defect: a consumer reads an outer provider's client instead of its nearest one's.
  it('property: each consumer gets the client of its nearest provider', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), (depth) => {
        const clients = Array.from({ length: depth }, () => ({ ...mockClient }) as NymbalClient)
        const seen: NymbalClient[] = []
        function Seen() {
          seen.push(useNymbalClient())
          return null
        }
        const tree = clients.reduceRight<ReactNode>(
          (inner, client) => (
            <NymbalProvider client={client}>
              <Seen />
              {inner}
            </NymbalProvider>
          ),
          null,
        )
        render(<>{tree}</>).unmount()
        expect(seen.map((client) => clients.indexOf(client))).toEqual(clients.map((_, i) => i))
      }),
    )
  })

  // Defect: outside a provider the hook hands back no client and the first call on it fails far from the cause.
  it('useNymbalClient throws when used outside provider', () => {
    const originalError = console.error
    console.error = () => {}
    try {
      expect(() => render(<Consumer />)).toThrow('useNymbalClient must be used within <NymbalProvider>')
    } finally {
      console.error = originalError
    }
  })
})
