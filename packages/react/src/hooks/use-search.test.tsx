import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { NymbalProvider } from '../context.js'
import { useSearch } from './use-search.js'
import type { NymbalClient, SearchState } from '@nymbalhq/sdk'
import type { ReactNode } from 'react'

function makeSearchStore(initial: Partial<SearchState> = {}) {
  let state: SearchState = {
    query: '',
    results: [],
    total: 0,
    loading: false,
    category: null,
    nextCursor: null,
    facets: [],
    ...initial,
  }
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    setState: (p: Partial<SearchState>) => {
      state = { ...state, ...p }
      for (const l of listeners) l()
    },
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    search: vi.fn().mockResolvedValue(undefined),
    clearSearch: vi.fn(),
    destroy: vi.fn(),
  }
}

function makeClient(searchStore = makeSearchStore()): NymbalClient {
  return { search: searchStore } as unknown as NymbalClient
}

function makeWrapper(client: NymbalClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <NymbalProvider client={client}>{children}</NymbalProvider>
  }
}

describe('useSearch', () => {
  it('mounts with the store’s current query and results, not a default', () => {
    const searchStore = makeSearchStore({
      query: 'mug',
      results: [{ id: 'p1' } as never],
      total: 1,
    })
    const { result } = renderHook(() => useSearch(), {
      wrapper: makeWrapper(makeClient(searchStore)),
    })
    expect(result.current.query).toBe(searchStore.getState().query)
    expect(result.current.results).toEqual(searchStore.getState().results)
  })

  it('re-renders when results change', () => {
    const searchStore = makeSearchStore()
    const { result } = renderHook(() => useSearch(), {
      wrapper: makeWrapper(makeClient(searchStore)),
    })
    act(() => {
      searchStore.setState({ results: [{ id: 'p1' } as never], total: 1 })
    })
    expect(result.current.results).toHaveLength(1)
  })
})
