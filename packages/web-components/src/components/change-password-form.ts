import '@nymbalhq/sdk/ns/auth'
import { html, nothing } from 'lit'
import { baseStyles, propertiesOf, type ElementSchema } from '../base-element.js'
import { NymbalFormElement, renderField } from '../form-element.js'
import { buttonStyles, fieldStyles } from '../view-styles.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-change-password-form',
  reactName: 'ChangePasswordForm',
  attributes: [],
  events: [],
  parts: ['form', 'field', 'label', 'input', 'error', 'submit', 'message'],
  slots: ['submit-label'],
  children: false,
}

/** Changes the signed-in customer's password; the store signs out every other session and renews this one. */
export class NymbalChangePasswordForm extends NymbalFormElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)
  static override styles = [baseStyles, buttonStyles, fieldStyles]

  protected override async send(): Promise<void> {
    await this.client.auth.changePassword(this.value('currentPassword'), this.value('newPassword'))
    this.renderRoot.querySelector('form')?.reset()
    this.notice = 'Password changed. Every other device is signed out.'
  }

  protected override render() {
    return html`
      ${this.renderError()}
      <form part="form" data-testid="change-password-form" @submit=${this.onSubmit}>
        ${renderField({
          id: 'change-current',
          name: 'currentPassword',
          label: 'Current password',
          type: 'password',
          autocomplete: 'current-password',
          required: true,
        })}
        ${renderField({
          id: 'change-new',
          name: 'newPassword',
          label: 'New password',
          type: 'password',
          autocomplete: 'new-password',
          required: true,
          minlength: 8,
          placeholder: 'At least 8 characters',
        })}
        <button
          type="submit"
          part="submit"
          class="btn btn-primary"
          data-testid="change-submit"
          ?disabled=${this.pending}
        >
          ${this.pending ? 'Saving...' : html`<slot name="submit-label">Change password</slot>`}
        </button>
        ${this.notice === null
          ? nothing
          : html`<p part="message" role="status" data-testid="change-done">${this.notice}</p>`}
      </form>
    `
  }
}
