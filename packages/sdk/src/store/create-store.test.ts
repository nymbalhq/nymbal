import fc from 'fast-check'
import { describe, it, expect } from 'vitest'
import { createStore } from './create-store.js'

describe('createStore', () => {
  it('property: over any sequence of partial updates, the state is their merge in order and every key not set keeps its value', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ a: fc.integer(), b: fc.string() }, { requiredKeys: [] }), {
          maxLength: 8,
        }),
        (updates) => {
          const initial = { a: 0, b: '', c: true }
          const store = createStore(initial)
          for (const update of updates) store.setState(update)
          expect(store.getState()).toEqual(
            updates.reduce((state, u) => ({ ...state, ...u }), initial),
          )
        },
      ),
    )
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

  it('a subscriber is notified once per setState and reads the new state', () => {
    const store = createStore({ x: 0 })
    const seen: number[] = []
    store.subscribe(() => seen.push(store.getState().x))
    store.setState({ x: 1 })
    store.setState((prev) => ({ x: prev.x + 1 }))
    expect(seen).toEqual([1, 2])
  })

  it('unsubscribe stops only that listener: it sees the states before, the other sees every one', () => {
    const store = createStore({ x: 0 })
    const gone: number[] = []
    const kept: number[] = []
    const unsub = store.subscribe(() => gone.push(store.getState().x))
    store.subscribe(() => kept.push(store.getState().x))
    store.setState({ x: 1 })
    unsub()
    store.setState({ x: 2 })
    expect(gone).toEqual([1])
    expect(kept).toEqual([1, 2])
  })

  it('destroy removes every listener: none sees a state set after it', () => {
    const store = createStore({ x: 0 })
    const seen: number[] = []
    store.subscribe(() => seen.push(store.getState().x))
    store.subscribe(() => seen.push(store.getState().x * 10))
    store.setState({ x: 1 })
    const before = seen.length
    store.destroy()
    store.setState({ x: 2 })
    expect(seen.length).toBe(before)
  })
})
