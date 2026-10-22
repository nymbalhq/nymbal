import { css, html, nothing } from 'lit'
import {
  baseStyles,
  NymbalElement,
  parsedJson,
  propertiesOf,
  type ElementSchema,
} from '../base-element.js'
import { formatPrice } from '../format.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-order-summary',
  reactName: 'OrderSummary',
  // An order's lines and money as `GET /api/orders/:n` serves them; the element adds nothing up itself.
  attributes: [
    { name: 'items', prop: 'items', type: 'json' },
    { name: 'subtotal-minor', prop: 'subtotalMinor', type: 'number' },
    { name: 'discount-minor', prop: 'discountMinor', type: 'number' },
    { name: 'shipping-minor', prop: 'shippingMinor', type: 'number' },
    { name: 'tax-minor', prop: 'taxMinor', type: 'number' },
    { name: 'total-minor', prop: 'totalMinor', type: 'number' },
    { name: 'currency', prop: 'currency', type: 'string' },
  ],
  events: [],
  parts: ['summary', 'line', 'totals', 'subtotal', 'discount', 'shipping', 'tax', 'total'],
  slots: [],
  children: false,
}

interface Line {
  name: string
  qty: number
  unitPriceMinor: number
  lineTotalMinor: number
}

const known = (n: number | undefined): n is number => n !== undefined && !Number.isNaN(n)

/** A placed order's lines, subtotal, discount (when there is one), shipping, tax and total. */
export class NymbalOrderSummary extends NymbalElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        font-family: var(--nymbal-font-family, system-ui, -apple-system, sans-serif);
        color: var(--nymbal-color-text, #18181b);
      }
      [part~='summary'] {
        padding: var(--nymbal-spacing-lg, 1.5rem);
        background-color: var(--nymbal-color-surface, #ffffff);
        border: 1px solid var(--nymbal-color-border, #e4e4e7);
        border-radius: var(--nymbal-radius-lg, 0.75rem);
      }
      h2 {
        margin: 0 0 var(--nymbal-spacing-md, 1rem);
        line-height: 1.2;
        font-size: var(--nymbal-font-size-lg, 1.125rem);
        font-weight: var(--nymbal-font-weight-bold, 700);
      }
      ul {
        margin: 0 0 var(--nymbal-spacing-md, 1rem);
        padding: 0;
        list-style: none;
      }
      [part~='line'],
      [part~='subtotal'],
      [part~='discount'],
      [part~='shipping'],
      [part~='tax'],
      [part~='total'] {
        display: flex;
        justify-content: space-between;
        gap: var(--nymbal-spacing-md, 1rem);
        padding-block: var(--nymbal-spacing-xs, 0.25rem);
        font-size: var(--nymbal-font-size-sm, 0.875rem);
      }
      .qty {
        color: var(--nymbal-color-text-muted, #71717a);
      }
      [part~='totals'] {
        margin: 0;
        padding-top: var(--nymbal-spacing-sm, 0.5rem);
        border-top: 1px solid var(--nymbal-color-border, #e4e4e7);
      }
      dt,
      dd {
        margin: 0;
      }
      [part~='discount'] dd {
        color: var(--nymbal-color-success, #16a34a);
      }
      [part~='total'] {
        margin-top: var(--nymbal-spacing-sm, 0.5rem);
        padding-top: var(--nymbal-spacing-sm, 0.5rem);
        border-top: 1px solid var(--nymbal-color-border, #e4e4e7);
        font-size: var(--nymbal-font-size-base, 1rem);
        font-weight: var(--nymbal-font-weight-bold, 700);
      }
    `,
  ]

  declare items: unknown
  declare subtotalMinor: number | undefined
  declare discountMinor: number | undefined
  declare shippingMinor: number | undefined
  declare taxMinor: number | undefined
  declare totalMinor: number | undefined
  declare currency: string | undefined

  protected override render() {
    const lines = parsedJson<Line[]>(this, 'items', this.items)
    const money = (minor: number): string => formatPrice(minor, this.currency ?? 'GBP')
    const row = (part: string, label: string, minor: number | undefined, shown = money) =>
      known(minor)
        ? html`<div part=${part}>
            <dt>${label}</dt>
            <dd>${shown(minor)}</dd>
          </div>`
        : nothing
    return html`
      <section part="summary" data-testid="order-summary">
        <h2>Order Summary</h2>
        <ul>
          ${(Array.isArray(lines) ? lines : []).map(
            (line) => html`
              <li part="line">
                <span>${line.name} <span class="qty">&times; ${line.qty}</span></span>
                <span>${money(line.lineTotalMinor)}</span>
              </li>
            `,
          )}
        </ul>
        <dl part="totals">
          ${row('subtotal', 'Subtotal', this.subtotalMinor)}
          ${known(this.discountMinor) && this.discountMinor !== 0
            ? row('discount', 'Discount', this.discountMinor, (m) => `−${money(m)}`)
            : nothing}
          ${row('shipping', 'Shipping', this.shippingMinor, (m) => (m === 0 ? 'Free' : money(m)))}
          ${row('tax', 'Tax', this.taxMinor)}
        </dl>
        ${known(this.totalMinor)
          ? html`<div part="total">
              <span>Total</span>
              <span>${money(this.totalMinor)}</span>
            </div>`
          : nothing}
      </section>
    `
  }
}
