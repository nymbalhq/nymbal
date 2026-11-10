import '@nymbalhq/sdk/ns/auth'
import { html, nothing } from 'lit'
import { apiErrorCode } from '../api-error.js'
import { baseStyles, propertiesOf, type ElementSchema } from '../base-element.js'
import { NymbalFormElement, renderField } from '../form-element.js'
import { buttonStyles, fieldStyles } from '../view-styles.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-verify-email',
  reactName: 'VerifyEmail',
  attributes: [],
  events: [
    {
      name: 'nymbal:auth:signed-in',
      prop: 'onSignedIn',
      detail: '{ customer: unknown }',
    },
  ],
  parts: ['form', 'field', 'label', 'input', 'error', 'submit', 'message'],
  slots: [],
  children: false,
}

const INVALID_CODE = 'auth.verify_link_invalid'

const SENT =
  'If that email is waiting to be confirmed, its confirmation link is on its way. It works for 24 hours.'

/**
 * Confirms a sign-up's email with the token its mail's link carries in the fragment, and signs the shopper in; the page
 * decides where they go next (`nymbal:auth:signed-in`). The token is taken out of the address bar as the element
 * connects, and nothing is sent until the shopper presses the button: a mail scanner that runs the page must not use
 * the link. With no token, or once the store refuses it, the element offers to mail the link again, and that form ends
 * on one text whatever the address and whatever the store answered.
 */
export class NymbalVerifyEmail extends NymbalFormElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)
  static override styles = [baseStyles, buttonStyles, fieldStyles]

  // The page leaves on a confirmation, and a resend ends on its note: neither form takes a second press.
  protected override readonly lockOnSuccess = true

  private token = ''
  private refused = false
  private sent = false
  private action: 'verify' | 'resend' = 'verify'

  override connectedCallback(): void {
    super.connectedCallback()
    const token = new URLSearchParams(location.hash.slice(1)).get('token')
    if (token === null) return
    this.token = token
    history.replaceState(history.state, '', `${location.pathname}${location.search}`)
  }

  private readonly onVerify = (event: Event): void => {
    this.action = 'verify'
    this.onSubmit(event)
  }

  private readonly onResend = (event: Event): void => {
    this.action = 'resend'
    this.onSubmit(event)
  }

  protected override async send(): Promise<void> {
    if (this.action === 'resend') {
      // A refusal (a rate limit, the network) shows the same text, so the page never tells one address from another.
      await this.client.auth.resendVerification(this.value('email')).catch(() => undefined)
      this.sent = true
      return
    }
    try {
      await this.client.auth.verifyEmail(this.token)
    } catch (err) {
      if (apiErrorCode(err) === INVALID_CODE) this.refused = true
      throw err
    }
    this.emit('nymbal:auth:signed-in', { customer: this.client.auth.getState().customer })
  }

  protected override failureText(err: unknown): string {
    return err instanceof Error && err.message !== ''
      ? err.message
      : 'Your email could not be confirmed. Please try again.'
  }

  protected override render() {
    if (this.sent) {
      return html`<p part="message" role="status" data-testid="resend-sent">${SENT}</p>`
    }
    // A server, and a first render taking over a server's, cannot know the fragment: they show the resend form.
    if (this.readsStores && this.token !== '' && !this.refused) {
      return html`
        ${this.renderError()}
        <form part="form" data-testid="verify-form" @submit=${this.onVerify}>
          <p part="message">Confirm your email address to finish signing up.</p>
          <button
            type="submit"
            part="submit"
            class="btn btn-primary"
            data-testid="verify-submit"
            ?disabled=${this.pending}
          >
            ${this.pending ? 'Confirming...' : 'Confirm my email'}
          </button>
        </form>
      `
    }
    return html`
      ${this.refused
        ? html`<p part="message" role="alert" data-testid="verify-invalid">
            This link is no longer valid. Links work once, for 24 hours. Enter your email for a new
            one.
          </p>`
        : nothing}
      <form part="form" data-testid="resend-form" @submit=${this.onResend}>
        ${renderField({
          id: 'resend-email',
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
          data-testid="resend-submit"
          ?disabled=${this.pending}
        >
          ${this.pending ? 'Sending...' : 'Send a new link'}
        </button>
      </form>
    `
  }
}
