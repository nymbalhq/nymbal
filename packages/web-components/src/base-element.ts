import type { NymbalClient } from '@nymbalhq/sdk'
import { getClient } from './registry.js'

/** `HTMLElement`, or a stand-in on a server, where the module is imported but no element is ever made. */
export const HTMLElementBase =
  typeof HTMLElement !== 'undefined' ? HTMLElement : (class {} as unknown as typeof HTMLElement)

export abstract class NymbalElement extends HTMLElementBase {
  private _unsubs: Array<() => void> = []
  private _renderQueued = false

  protected get client(): NymbalClient {
    return getClient()
  }

  protected subscribeToStore(store: { subscribe(fn: () => void): () => void }): void {
    this._unsubs.push(store.subscribe(() => this.requestRender()))
  }

  protected requestRender(): void {
    if (this._renderQueued) return
    this._renderQueued = true
    queueMicrotask(() => {
      this._renderQueued = false
      this.render()
    })
  }

  connectedCallback(): void {
    this.setup()
    this.render()
  }

  disconnectedCallback(): void {
    for (const fn of this._unsubs) fn()
    this._unsubs = []
  }

  protected abstract setup(): void
  protected abstract render(): void
}
