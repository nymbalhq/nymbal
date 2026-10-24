import { describe, it, expect, vi } from 'vitest'
import { createStore } from './create-store.js'

describe('createStore', () => {
  it('initial state is accessible via getState()', () => {
    const store = createStore({ count: 0, loading: false })
    expect(store.getState()).toEqual({ count: 0, loading: false })
  })

  it('setState merges partial state', () => {
    const store = createStore({ count: 0, name: 'a' })
    store.setState({ count: 5 })
    expect(store.getState()).toEqual({ count: 5, name: 'a' })
  })

  it('setState with function receives previous state', () => {
    const store = createStore({ count: 2 })
    store.setState((prev) => ({ count: prev.count + 3 }))
    expect(store.getState().count).toBe(5)
  })

  it('subscribers are notified on setState', () => {
    const store = createStore({ x: 0 })
    const listener = vi.fn()
    store.subscribe(listener)
    store.setState({ x: 1 })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('unsubscribe returned function removes listener', () => {
    const store = createStore({ x: 0 })
    const listener = vi.fn()
    const unsub = store.subscribe(listener)
    unsub()
    store.setState({ x: 1 })
    expect(listener).not.toHaveBeenCalled()
  })

  it('destroy removes all listeners', () => {
    const store = createStore({ x: 0 })
    const listener = vi.fn()
    store.subscribe(listener)
    store.destroy()
    store.setState({ x: 1 })
    expect(listener).not.toHaveBeenCalled()
  })
})
