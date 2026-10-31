import '@nymbalhq/sdk/ns/auth'
import { css, html, nothing } from 'lit'
import type { Customer } from '@nymbalhq/types'
import { baseStyles, parsedJson, propertiesOf, type ElementSchema } from '../base-element.js'
import { NymbalFormElement, renderField } from '../form-element.js'
import { buttonStyles, fieldStyles } from '../view-styles.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-profile-form',
  reactName: 'ProfileForm',
  // The customer a server read, shown until the auth store settles.
  attributes: [{ name: 'customer', prop: 'customer', type: 'json' }],
  events: [
    {
      name: 'nymbal:profile:saved',
      prop: 'onSaved',
      detail: '{ customer: unknown }',
    },
  ],
  parts: ['form', 'row', 'field', 'label', 'input', 'actions', 'submit', 'error', 'message'],
  slots: ['submit-label'],
  children: false,
}

/** The signed-in customer's name and phone, filled from the auth store and saved through it. */
export class NymbalProfileForm extends NymbalFormElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)
  static override styles = [
    baseStyles,
    buttonStyles,
    fieldStyles,
    css`
      [part~='row'] {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
        gap: 0 var(--nymbal-spacing-md, 1rem);
      }
      [part~='submit'] {
        width: auto;
      }
    `,
  ]

  declare customer: unknown

  protected override stores() {
    return [this.client.auth]
  }

  protected override storeSettled(): void {
    this.customer = undefined
  }

  protected override async send(): Promise<void> {
    await this.client.auth.updateProfile({
      firstName: this.value('firstName'),
      lastName: this.value('lastName'),
      phone: this.value('phone'),
    })
    this.notice = 'Profile updated successfully.'
    this.emit('nymbal:profile:saved', { customer: this.client.auth.getState().customer })
  }

  protected override failureText(err: unknown): string {
    return err instanceof Error && err.message !== '' ? err.message : 'Failed to update profile.'
  }

  protected override render() {
    const customer =
      parsedJson<Customer>(this, 'customer', this.customer) ??
      (this.readsStores ? this.client.auth.getState().customer : null)
    return html`
      ${this.renderError()}
      <form part="form" data-testid="profile-form" @submit=${this.onSubmit}>
        <div part="row">
          ${renderField({
            id: 'profile-firstName',
            name: 'firstName',
            label: 'First Name',
            autocomplete: 'given-name',
            value: customer?.firstName ?? '',
          })}
          ${renderField({
            id: 'profile-lastName',
            name: 'lastName',
            label: 'Last Name',
            autocomplete: 'family-name',
            value: customer?.lastName ?? '',
          })}
        </div>
        ${renderField({
          id: 'profile-email',
          name: 'email',
          label: 'Email',
          type: 'email',
          autocomplete: 'email',
          disabled: true,
          value: customer?.email ?? '',
        })}
        ${renderField({
          id: 'profile-phone',
          name: 'phone',
          label: 'Phone',
          type: 'tel',
          autocomplete: 'tel',
          value: customer?.phone ?? '',
        })}
        <div part="actions">
          <button
            type="submit"
            part="submit"
            class="btn btn-primary"
            data-testid="profile-save"
            ?disabled=${this.pending}
          >
            ${this.pending ? 'Saving...' : html`<slot name="submit-label">Save Changes</slot>`}
          </button>
        </div>
        ${this.notice === null
          ? nothing
          : html`<p part="message" role="status">${this.notice}</p>`}
      </form>
    `
  }
}
