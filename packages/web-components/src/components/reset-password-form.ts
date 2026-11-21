import '@nymbalhq/sdk/ns/auth'
import { html } from 'lit'
import { apiErrorCode } from '../api-error.js'
import { baseStyles, propertiesOf, type ElementSchema } from '../base-element.js'
import { NymbalFormElement, renderField } from '../form-element.js'
import { buttonStyles, fieldStyles } from '../view-styles.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-reset-password-form',
  reactName: 'ResetPasswordForm',
  attributes: [],
  events: [
    {
      name: 'nymbal:auth:signed-in',
      prop: 'onSignedIn',
      detail: '{ customer: unknown }',
    },
  ],
  parts: ['form', 'field', 'label', 'input', 'error', 'submit', 'message', 'link'],
  slots: ['submit-label'],
  children: false,
}

const FORGOT_PATH = '/account/forgot-password'
const INVALID_CODE = 'auth.reset_link_invalid'

/**
 * Sets a password with the token a reset mail's link carries in its fragment, and signs the shopper in; the page decides
 * where they go next (`nymbal:auth:signed-in`). The token is taken out of the address bar as the element connects, so
 * it is in no history entry and no copied URL. With no token, or once the store refuses it, the element says so and
 * links to the forgot page.
 */
export class NymbalResetPasswordForm extends NymbalFormElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)
  static override styles = [baseStyles, buttonStyles, fieldStyles]

  // The page leaves on success; the link is spent, so a second press could only be refused.
  protected override readonly lockOnSuccess = true

  private token = ''
  private refused = false

  override connectedCallback(): void {
    super.connectedCallback()
    const token = new URLSearchParams(location.hash.slice(1)).get('token')
    if (token === null) return
    this.token = token
    history.replaceState(history.state, '', `${location.pathname}${location.search}`)
  }

  protected override async send(): Promise<void> {
    try {
      await this.client.auth.resetPassword(this.token, this.value('password'))
    } catch (err) {
      if (apiErrorCode(err) === INVALID_CODE) this.refused = true
      throw err
    }
    this.emit('nymbal:auth:signed-in', { customer: this.client.auth.getState().customer })
  }

  protected override render() {
    // A server, and a first render taking over a server's, cannot know the fragment: they show the form.
    if (this.readsStores && (this.token === '' || this.refused)) {
      return html`
        <p part="message" role="alert" data-testid="reset-invalid">
          This link is no longer valid. Links work once, for 15 minutes.
          <a part="link" href=${FORGOT_PATH}>Ask for a new link</a>
        </p>
      `
    }
    return html`
      ${this.renderError()}
      <form part="form" data-testid="reset-form" @submit=${this.onSubmit}>
        ${renderField({
          id: 'reset-password',
          name: 'password',
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
          data-testid="reset-submit"
          ?disabled=${this.pending}
        >
          ${this.pending ? 'Saving...' : html`<slot name="submit-label">Set password</slot>`}
        </button>
      </form>
    `
  }
}
