import '@nymbalhq/sdk/ns/auth'
import { css, html } from 'lit'
import { baseStyles, propertiesOf, type ElementSchema } from '../base-element.js'
import { NymbalFormElement, renderField } from '../form-element.js'
import { buttonStyles, fieldStyles } from '../view-styles.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-register-form',
  reactName: 'RegisterForm',
  attributes: [],
  events: [
    {
      name: 'nymbal:auth:signed-in',
      prop: 'onSignedIn',
      detail: '{ customer: unknown }',
    },
    {
      name: 'nymbal:auth:verification-sent',
      prop: 'onVerificationSent',
      detail: '{ email: string }',
    },
  ],
  parts: ['form', 'row', 'field', 'label', 'input', 'error', 'submit', 'message'],
  slots: ['submit-label'],
  children: false,
}

/**
 * Creates the shopper's account and signs them in; the page decides where they go next. On a store that confirms
 * addresses nobody is signed in: the form gives way to a note that a link was mailed, alike for every address.
 */
export class NymbalRegisterForm extends NymbalFormElement {
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
    `,
  ]

  // The page leaves on success, or the form gives way to the note; a second submit would register the email twice.
  protected override readonly lockOnSuccess = true

  /** The address a confirmation link went to, once the store says one did. */
  private sentTo: string | null = null

  protected override async send(): Promise<void> {
    if (this.value('password') !== this.value('confirmPassword')) {
      throw new Error('Passwords do not match.')
    }
    const email = this.value('email')
    const outcome = await this.client.auth.register({
      email,
      password: this.value('password'),
      firstName: this.value('firstName'),
      lastName: this.value('lastName'),
      phone: this.value('phone'),
    })
    if (outcome === 'verification-sent') {
      this.sentTo = email
      this.emit('nymbal:auth:verification-sent', { email })
      return
    }
    this.emit('nymbal:auth:signed-in', { customer: this.client.auth.getState().customer })
  }

  protected override failureText(err: unknown): string {
    return err instanceof Error && err.message !== ''
      ? err.message
      : 'Registration failed. Please try again.'
  }

  protected override render() {
    if (this.sentTo !== null) {
      return html`<p part="message" role="status" data-testid="register-sent">
        We sent a link to ${this.sentTo}. It works for 24 hours.
      </p>`
    }
    return html`
      ${this.renderError()}
      <form part="form" data-testid="register-form" @submit=${this.onSubmit}>
        <div part="row">
          ${renderField({
            id: 'register-firstName',
            name: 'firstName',
            label: 'First Name',
            autocomplete: 'given-name',
            placeholder: 'First name',
          })}
          ${renderField({
            id: 'register-lastName',
            name: 'lastName',
            label: 'Last Name',
            autocomplete: 'family-name',
            placeholder: 'Last name',
          })}
        </div>
        ${renderField({
          id: 'register-email',
          name: 'email',
          label: 'Email',
          type: 'email',
          autocomplete: 'email',
          required: true,
          placeholder: 'you@example.com',
        })}
        ${renderField({
          id: 'register-password',
          name: 'password',
          label: 'Password',
          type: 'password',
          autocomplete: 'new-password',
          required: true,
          minlength: 8,
          placeholder: 'Choose a password',
        })}
        ${renderField({
          id: 'register-confirmPassword',
          name: 'confirmPassword',
          label: 'Confirm Password',
          type: 'password',
          autocomplete: 'new-password',
          required: true,
          placeholder: 'Confirm your password',
        })}
        ${renderField({
          id: 'register-phone',
          name: 'phone',
          label: 'Phone (optional)',
          type: 'tel',
          autocomplete: 'tel',
          placeholder: '+44 7700 900000',
        })}
        <button
          type="submit"
          part="submit"
          class="btn btn-primary"
          data-testid="register-submit"
          ?disabled=${this.pending}
        >
          ${this.pending ? 'Creating account...' : html`<slot name="submit-label">Create Account</slot>`}
        </button>
      </form>
    `
  }
}
