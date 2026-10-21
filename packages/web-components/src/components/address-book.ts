import { css, html, nothing } from 'lit'
import type { CustomerAddress } from '@nymbalhq/types'
import { baseStyles, propertiesOf, type ElementSchema } from '../base-element.js'
import { NymbalFormElement } from '../form-element.js'
import { buttonStyles, fieldStyles } from '../view-styles.js'
import { NymbalAddressForm } from './address-form.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-address-book',
  reactName: 'AddressBook',
  attributes: [],
  events: [
    {
      name: 'nymbal:address-book:changed',
      prop: 'onChanged',
      detail: '{ address: unknown }',
    },
  ],
  parts: [
    'list',
    'status',
    'empty',
    'empty-title',
    'empty-text',
    'address',
    'address-badge',
    'address-line',
    'add',
    'add-title',
    'form',
    'actions',
    'submit',
    'error',
    'message',
  ],
  slots: ['add-title'],
  children: false,
}

/** The signed-in customer's saved addresses, and the form that adds one. */
export class NymbalAddressBook extends NymbalFormElement {
  static override schema = SCHEMA
  static uses = [NymbalAddressForm]
  static override properties = propertiesOf(SCHEMA)
  static override styles = [
    baseStyles,
    buttonStyles,
    fieldStyles,
    css`
      [part~='list'] {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
        gap: var(--nymbal-spacing-md, 1rem);
      }
      [part~='status'],
      [part~='empty-text'] {
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        color: var(--nymbal-color-text-muted, #71717a);
      }
      [part~='empty'] {
        grid-column: 1 / -1;
      }
      [part~='empty-title'] {
        margin: 0 0 var(--nymbal-spacing-xs, 0.25rem);
        font-size: var(--nymbal-font-size-base, 1rem);
        font-weight: var(--nymbal-font-weight-medium, 500);
      }
      [part~='address'] {
        position: relative;
        padding: var(--nymbal-spacing-md, 1rem);
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        line-height: 1.6;
        border: 1px solid var(--nymbal-color-border, #e4e4e7);
        border-radius: var(--nymbal-radius-md, 0.5rem);
      }
      [part~='address-badge'] {
        display: inline-block;
        margin-bottom: var(--nymbal-spacing-xs, 0.25rem);
        padding: 0 var(--nymbal-spacing-sm, 0.5rem);
        font-size: var(--nymbal-font-size-xs, 0.75rem);
        font-weight: var(--nymbal-font-weight-medium, 500);
        color: var(--nymbal-color-text-inverse, #ffffff);
        background: var(--nymbal-color-primary, #18181b);
        border-radius: var(--nymbal-radius-full, 9999px);
      }
      [part~='add'] {
        margin-top: var(--nymbal-spacing-xl, 2rem);
      }
      [part~='add-title'] {
        margin: 0 0 var(--nymbal-spacing-md, 1rem);
        font-size: var(--nymbal-font-size-lg, 1.125rem);
        font-weight: var(--nymbal-font-weight-bold, 700);
      }
      [part~='submit'] {
        width: auto;
      }
    `,
  ]

  /** null until the first list answers. */
  private addresses: CustomerAddress[] | null = null
  private loadFailed = false

  override connectedCallback(): void {
    super.connectedCallback()
    void this.load()
  }

  private async load(): Promise<void> {
    try {
      this.addresses = await this.client.customer.addresses.list()
      this.loadFailed = false
    } catch {
      this.loadFailed = true
    }
    this.requestUpdate()
  }

  private get addressForm(): NymbalAddressForm | null {
    return this.renderRoot.querySelector<NymbalAddressForm>('nymbal-address-form')
  }

  protected override async send(): Promise<void> {
    const form = this.addressForm
    if (form === null) throw new Error('The address fields have not rendered.')
    const address = await this.client.customer.addresses.create(form.value)
    form.reset()
    this.notice = 'Address saved successfully.'
    this.emit('nymbal:address-book:changed', { address })
    await this.load()
  }

  protected override failureText(): string {
    return 'Failed to save address. Please try again.'
  }

  private readonly onAddSubmit = (event: Event): void => {
    // The fields are in the address form's shadow root, out of reach of this form's own validation.
    if (!this.pending && this.addressForm?.reportValidity() === false) {
      event.preventDefault()
      return
    }
    this.onSubmit(event)
  }

  private renderAddress(a: CustomerAddress) {
    return html`
      <div part="address" data-testid="address-${a.id}">
        ${a.isDefaultShipping ? html`<span part="address-badge">Default Shipping</span>` : nothing}
        ${a.isDefaultBilling ? html`<span part="address-badge">Default Billing</span>` : nothing}
        <div part="address-line">${a.firstName} ${a.lastName}</div>
        <div part="address-line">${a.addressLine1}</div>
        ${a.addressLine2 ? html`<div part="address-line">${a.addressLine2}</div>` : nothing}
        <div part="address-line">${a.city}, ${a.region} ${a.postalCode}</div>
        <div part="address-line">${a.country}</div>
      </div>
    `
  }

  private renderList() {
    if (this.loadFailed) return html`<p part="status">Unable to load addresses.</p>`
    if (this.addresses === null) return html`<p part="status">Loading addresses...</p>`
    if (this.addresses.length === 0) {
      return html`
        <div part="empty">
          <h2 part="empty-title">No saved addresses</h2>
          <p part="empty-text">Add an address below to get started.</p>
        </div>
      `
    }
    return this.addresses.map((a) => this.renderAddress(a))
  }

  protected override render() {
    return html`
      <div part="list" data-testid="addresses-list">${this.renderList()}</div>
      <section part="add">
        <h2 part="add-title"><slot name="add-title">Add New Address</slot></h2>
        <form part="form" data-testid="add-address-form" @submit=${this.onAddSubmit}>
          <nymbal-address-form id-prefix="new-address"></nymbal-address-form>
          <div part="actions">
            <button
              type="submit"
              part="submit"
              class="btn btn-primary"
              data-testid="save-address"
              ?disabled=${this.pending}
            >
              ${this.pending ? 'Saving...' : 'Save Address'}
            </button>
          </div>
        </form>
        ${this.renderError()}
        ${this.notice === null
          ? nothing
          : html`<p part="message" role="status">${this.notice}</p>`}
      </section>
    `
  }
}
