import '@nymbalhq/sdk/ns/auth'
import { html } from 'lit'
import { baseStyles, propertiesOf, type ElementSchema } from '../base-element.js'
import { NymbalFormElement, renderField } from '../form-element.js'
import { buttonStyles, fieldStyles } from '../view-styles.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-forgot-password-form',
  reactName: 'ForgotPasswordForm',
  attributes: [],
  events: [],
  parts: ['form', 'field', 'label', 'input', 'submit', 'message'],
  slots: ['submit-label'],
  children: false,
}

const SENT =
  'If an account uses that email, a link to set a new password is on its way. It works once, for 15 minutes.'

/**
 * Asks for a password reset link. Every request ends on one text, whoever's address it was and whatever the store
 * answered: a different answer would tell a stranger which addresses have accounts.
 */
export class NymbalForgotPasswordForm extends NymbalFormElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)
  static override styles = [baseStyles, buttonStyles, fieldStyles]

  private sent = false

  protected override async send(): Promise<void> {
    // A refusal (a rate limit, the network) shows the same text, so the page never tells one address from another.
    await this.client.auth.requestPasswordReset(this.value('email')).catch(() => undefined)
    this.sent = true
  }

  protected override render() {
    if (this.sent) {
      return html`<p part="message" role="status" data-testid="forgot-sent">${SENT}</p>`
    }
    return html`
      <form part="form" data-testid="forgot-form" @submit=${this.onSubmit}>
        ${renderField({
          id: 'forgot-email',
          name: 'email',
          label: 'Email',
          type: 'email',
          autocomplete: 'email',
          required: true,
          placeholder: 'you@example.com',
        })}
        <button
          type="submit"
          part="submit"
          class="btn btn-primary"
          data-testid="forgot-submit"
          ?disabled=${this.pending}
        >
          ${this.pending ? 'Sending...' : html`<slot name="submit-label">Send reset link</slot>`}
        </button>
      </form>
    `
  }
}
