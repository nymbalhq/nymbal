import { css, html, nothing, type PropertyValues } from 'lit'
import { baseStyles, NymbalElement, propertiesOf, type ElementSchema } from '../base-element.js'
import { cardProductOf, NymbalProductCard } from './product-card.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-recently-viewed',
  reactName: 'RecentlyViewed',
  // `current`: the page's product, recorded as viewed and left out of the list. `limit`: how many cards it shows.
  attributes: [
    { name: 'current', prop: 'current', type: 'string' },
    { name: 'limit', prop: 'limit', type: 'number' },
  ],
  events: [
    { name: 'nymbal:recently-viewed:loaded', prop: 'onLoaded', detail: '{ productIds: string[] }' },
  ],
  parts: ['section', 'heading', 'grid'],
  slots: ['heading'],
  children: false,
}

const DEFAULT_LIMIT = 4

type Listed = Parameters<typeof cardProductOf>[0] & { id: string }

/**
 * The shopper's recently viewed products, from the store: one page view records `current` once, then reads the list
 * once. It renders nothing until the list has something besides `current`, and nothing without a client (a server).
 */
export class NymbalRecentlyViewed extends NymbalElement {
  static override schema = SCHEMA
  static uses = [NymbalProductCard]
  static override properties = { ...propertiesOf(SCHEMA), listed: { state: true } }
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        font-family: var(--nymbal-font-family, system-ui, -apple-system, sans-serif);
        color: var(--nymbal-color-text, #18181b);
      }
      [part~='section'] {
        margin-top: var(--nymbal-spacing-xl, 2rem);
      }
      [part~='heading'] {
        margin: 0 0 var(--nymbal-spacing-lg, 1.5rem);
        font-size: var(--nymbal-font-size-xl, 1.25rem);
        font-weight: var(--nymbal-font-weight-bold, 700);
      }
      [part~='grid'] {
        display: grid;
        gap: var(--nymbal-spacing-md, 1rem);
        grid-template-columns: 1fr;
      }
      @media (min-width: 641px) {
        [part~='grid'] {
          grid-template-columns: repeat(2, 1fr);
          gap: var(--nymbal-spacing-lg, 1.5rem);
        }
      }
      @media (min-width: 1025px) {
        [part~='grid'] {
          grid-template-columns: repeat(4, 1fr);
        }
      }
    `,
  ]

  declare current: string | undefined
  declare limit: number | undefined
  declare listed: Listed[]

  /** The last `current` recorded: a re-render, a reconnect or the same value again records nothing. */
  private recorded: string | undefined
  private started = false
  /** Reads run one after another, so each new `current` is recorded before the list it changes is read. */
  private reads: Promise<void> = Promise.resolve()

  constructor() {
    super()
    this.listed = []
  }

  private get shown(): Listed[] {
    const n = this.limit
    const limit = typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : DEFAULT_LIMIT
    return this.listed.filter((p) => p.id !== this.current).slice(0, limit)
  }

  /** After the first update, so a `current` set as the element connects is recorded before the first read. */
  protected override updated(changed: PropertyValues): void {
    super.updated(changed)
    if (!this.hasClient) return
    const current = typeof this.current === 'string' && this.current !== '' ? this.current : undefined
    if (!this.started) {
      this.started = true
      this.queueRead(current)
    } else if (changed.has('current') && current !== undefined && current !== this.recorded) {
      this.queueRead(current)
    }
  }

  private queueRead(current: string | undefined): void {
    if (current !== undefined) this.recorded = current
    this.reads = this.reads.then(() => this.read(current))
  }

  private async read(current: string | undefined): Promise<void> {
    const { recentlyViewed } = this.client
    if (current !== undefined) {
      try {
        await recentlyViewed.record(current)
      } catch (err) {
        console.warn('[nymbal-recently-viewed] the view was not recorded', err)
      }
    }
    try {
      this.listed = (await recentlyViewed.list()).items as Listed[]
    } catch (err) {
      console.warn('[nymbal-recently-viewed] the list could not be read', err)
      this.listed = []
    }
    await this.updateComplete
    this.dispatchEvent(
      new CustomEvent('nymbal:recently-viewed:loaded', {
        detail: { productIds: this.shown.map((p) => p.id) },
        bubbles: true,
        composed: true,
      }),
    )
  }

  protected override render() {
    const shown = this.readsStores ? this.shown : []
    if (shown.length === 0) return nothing
    return html`
      <section part="section">
        <h2 part="heading"><slot name="heading">Recently viewed</slot></h2>
        <div part="grid">
          ${shown.map(
            (p) =>
              html`<nymbal-product-card
                product=${JSON.stringify(cardProductOf(p))}
              ></nymbal-product-card>`,
          )}
        </div>
      </section>
    `
  }
}
