import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { NymbalProvider } from '../context.js'
import { useSearch } from './use-search.js'
import type { NymbalClient, SearchState } from '@nymbal/sdk'
import type { ReactNode } from 'react'

function makeSearchStore(initial: Partial<SearchState> = {}) {
  let state: SearchState = { query: '', results: [], total: 0, loading: false, ...initial }
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    setState: (p: Partial<SearchState>) => { state = { ...state, ...p }; for (const l of listeners) l() },
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) },
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
  it('initial state has empty results', () => {
    const { result } = renderHook(() => useSearch(), { wrapper: makeWrapper(makeClient()) })
    expect(result.current.results).toHaveLength(0)
    expect(result.current.query).toBe('')
  })

  it('exposes search function', async () => {
    const searchStore = makeSearchStore()
    const { result } = renderHook(() => useSearch(), { wrapper: makeWrapper(makeClient(searchStore)) })
    await act(async () => {
      await result.current.search('widget')
    })
    expect(searchStore.search).toHaveBeenCalledWith('widget')
  })

  it('re-renders when results change', () => {
    const searchStore = makeSearchStore()
    const { result } = renderHook(() => useSearch(), { wrapper: makeWrapper(makeClient(searchStore)) })
    act(() => { searchStore.setState({ results: [{ id: 'p1' } as never], total: 1 }) })
    expect(result.current.results).toHaveLength(1)
  })
})
