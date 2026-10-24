export type Listener = () => void

export interface Store<TState> {
  getState(): TState
  setState(partial: Partial<TState> | ((prev: TState) => Partial<TState>)): void
  subscribe(listener: Listener): () => void
  destroy(): void
}

export function createStore<TState extends object>(
  initialState: TState,
): Store<TState> {
  let state = initialState
  const listeners = new Set<Listener>()

  function getState(): TState {
    return state
  }

  function setState(partial: Partial<TState> | ((prev: TState) => Partial<TState>)): void {
    const next = typeof partial === 'function' ? partial(state) : partial
    state = { ...state, ...next }
    for (const listener of listeners) {
      listener()
    }
  }

  function subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  function destroy(): void {
    listeners.clear()
  }

  return { getState, setState, subscribe, destroy }
}
