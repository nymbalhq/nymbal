import {
  getPaymentDriver,
  registerPaymentDriver,
  type PaymentConfirmContext,
  type PaymentConfirmation,
  type PaymentDriver,
} from '@nymbalhq/sdk'
import type { PaymentClient } from '@nymbalhq/types'
import { css, nothing, type CSSResult } from 'lit'
import { NymbalElement, propertiesOf, type ElementSchema } from '../base-element.js'
import { stripeDriver } from '../payment-drivers/stripe.js'
import { testModeDriver } from '../payment-drivers/test-mode.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-payment-element',
  reactName: 'PaymentElement',
  attributes: [{ name: 'client', prop: 'client', type: 'json' }],
  events: [
    {
      name: 'nymbal:payment:status',
      prop: 'onStatusChange',
      detail: "{ status: 'pending' | 'ready' | 'error' }",
    },
  ],
  parts: ['error'],
  slots: [],
  children: false,
}

/** `pending` while a driver mounts; `error` when no payment can be taken, which a checkout must not submit past. */
export type PaymentElementStatus = 'pending' | 'ready' | 'error'

/** No client half: nothing to collect, so nothing is confirmed here. */
const NO_PAYMENT_STEP: PaymentConfirmation = { ok: true, confirmed: false }

function parseClient(value: string | null): PaymentClient | null | undefined {
  if (value === null || value === '' || value === 'null') return null
  try {
    const parsed = JSON.parse(value) as Partial<PaymentClient> | null
    if (parsed === null) return null
    if (typeof parsed.driver !== 'string' || typeof parsed.options !== 'object') return undefined
    return { driver: parsed.driver, options: { ...(parsed.options ?? {}) } }
  } catch {
    return undefined
  }
}

/**
 * <nymbal-payment-element client='<json>'>: renders the payments adapter's client half (GET /api/capabilities'
 * `payments.client`) through the driver the SDK registry holds under its `driver` name, and confirms a payment
 * through it. It emits `nymbal:payment:status` whenever `status` changes.
 */
export class NymbalPaymentElement extends NymbalElement {
  static override schema = SCHEMA

  /** The built-in drivers, except a name the project registered first: the project's driver wins, as its tag does. */
  static beforeDefine(): void {
    const drivers: Array<[string, PaymentDriver]> = [
      ['test-mode', testModeDriver],
      ['stripe', stripeDriver],
    ]
    for (const [name, driver] of drivers) {
      if (getPaymentDriver(name) === undefined) registerPaymentDriver(name, driver)
    }
  }
  static override properties = propertiesOf(SCHEMA)

  static override styles = css`
    nymbal-payment-element {
      display: block;
      font-family: var(--nymbal-font-family, system-ui, -apple-system, sans-serif);
    }
    nymbal-payment-element .nymbal-payment-note {
      margin: 0;
      font-size: var(--nymbal-font-size-sm, 0.875rem);
      color: var(--nymbal-color-text-muted, #71717a);
    }
    nymbal-payment-element .nymbal-payment-card {
      padding: var(--nymbal-spacing-sm, 0.5rem) var(--nymbal-spacing-md, 1rem);
      border: 1px solid var(--nymbal-color-border, #e4e4e7);
      border-radius: var(--nymbal-radius-md, 0.375rem);
      background: var(--nymbal-color-surface, #ffffff);
      min-height: 40px;
    }
    nymbal-payment-element [part~='error'] {
      margin: 0;
      font-size: var(--nymbal-font-size-sm, 0.875rem);
      color: var(--nymbal-color-error, #dc2626);
    }
  `

  private _status: PaymentElementStatus = 'pending'
  private _error = ''
  private _driver: PaymentDriver | null = null
  private _mounted: Promise<boolean> = Promise.resolve(true)
  private _rendered: string | null | undefined = undefined
  private _generation = 0

  get status(): PaymentElementStatus {
    return this._status
  }

  /**
   * The light DOM, so the payment driver's UI (Stripe's iframe) and the checkout form share one tree. Its styles join
   * the sheets of the tree it is in, where a shadow root would have held them.
   */
  protected override createRenderRoot(): HTMLElement {
    const root = this.getRootNode() as Document | ShadowRoot
    const sheet = (NymbalPaymentElement.styles as CSSResult).styleSheet
    if (sheet !== undefined && 'adoptedStyleSheets' in root && !root.adoptedStyleSheets.includes(sheet)) {
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]
    }
    return this
  }

  override connectedCallback(): void {
    super.connectedCallback()
    this.mountClient()
  }

  override attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    super.attributeChangedCallback(name, old, value)
    if (this.isConnected) this.mountClient()
  }

  /** The children are the driver's, mounted imperatively, so Lit renders none of its own. */
  protected override render() {
    return nothing
  }

  /**
   * Completes a payment the API left `requires_action`, once the driver has mounted, handing the driver the
   * checkout's `context`; the driver's answer as is.
   */
  async confirm(clientSecret: string, context?: PaymentConfirmContext): Promise<PaymentConfirmation> {
    const driver = this._driver
    if (this._status === 'error') return { ok: false, error: this._error }
    if (driver === null) return NO_PAYMENT_STEP
    if (!(await this._mounted)) return { ok: false, error: this._error }
    return driver.confirm(clientSecret, context)
  }

  private mountClient(): void {
    const attribute = this.getAttribute('client')
    // The same client half again (a reconnect, a framework re-setting the attribute) keeps what is mounted.
    if (attribute === this._rendered) return
    this._rendered = attribute
    const generation = ++this._generation
    this._driver = null
    this._mounted = Promise.resolve(true)
    this.clear()

    const client = parseClient(attribute)
    if (client === undefined)
      return this.fail('The store sent a payment client this page cannot read.')
    if (client === null) return this.setStatus('ready')
    const driver = getPaymentDriver(client.driver)
    if (driver === undefined) {
      return this.fail(`Payment method "${client.driver}" is not available on this storefront.`)
    }

    this._driver = driver
    this.setStatus('pending')
    this._mounted = Promise.resolve()
      .then(() => driver.mount(this, client.options))
      .then(
        () => {
          if (generation === this._generation) this.setStatus('ready')
          return true
        },
        (err: unknown) => {
          if (generation === this._generation) {
            this.fail(err instanceof Error ? err.message : 'The payment form could not be loaded.')
          }
          return false
        },
      )
  }

  private fail(message: string): void {
    this._error = message
    const p = document.createElement('p')
    p.setAttribute('part', 'error')
    p.setAttribute('data-testid', 'payment-element-error')
    p.setAttribute('role', 'alert')
    p.textContent = message
    this.clear(p)
    this.setStatus('error')
  }

  /**
   * Replaces what a driver or an error rendered. Lit's marker comment stays: its next update (a new `client`) writes
   * at it, and throws once it is gone.
   */
  private clear(...nodes: Node[]): void {
    for (const child of [...this.childNodes]) {
      if (child.nodeType !== Node.COMMENT_NODE) child.remove()
    }
    this.append(...nodes)
  }

  private setStatus(status: PaymentElementStatus): void {
    if (status === this._status) return
    this._status = status
    this.dispatchEvent(
      new CustomEvent('nymbal:payment:status', {
        bubbles: true,
        composed: true,
        detail: { status },
      }),
    )
  }
}
