import { html } from 'lit'
import { baseStyles, propertiesOf, type ElementSchema } from '../base-element.js'
import { NymbalFormElement, renderField } from '../form-element.js'
import { buttonStyles, fieldStyles } from '../view-styles.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-login-form',
  reactName: 'LoginForm',
  attributes: [],
  events: [
    {
      name: 'nymbal:auth:signed-in',
      prop: 'onSignedIn',
      detail: '{ customer: unknown }',
    },
  ],
  parts: ['form', 'field', 'label', 'input', 'error', 'submit'],
  slots: ['submit-label'],
  children: false,
}

/** Signs the shopper in; the page decides where they go next (`nymbal:auth:signed-in`). */
export class NymbalLoginForm extends NymbalFormElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)
  static override styles = [baseStyles, buttonStyles, fieldStyles]

  protected override async send(): Promise<void> {
    await this.client.auth.login(this.value('email'), this.value('password'))
    this.emit('nymbal:auth:signed-in', { customer: this.client.auth.getState().customer })
  }

  protected override failureText(err: unknown): string {
    return err instanceof Error && err.message !== '' ? err.message : 'Invalid email or password.'
  }

  protected override render() {
    return html`
      ${this.renderError()}
      <form part="form" data-testid="login-form" @submit=${this.onSubmit}>
        ${renderField({
          id: 'login-email',
          name: 'email',
          label: 'Email',
          type: 'email',
          autocomplete: 'email',
          required: true,
          placeholder: 'you@example.com',
        })}
        ${renderField({
          id: 'login-password',
          name: 'password',
          label: 'Password',
          type: 'password',
          autocomplete: 'current-password',
          required: true,
          placeholder: 'Your password',
        })}
        <button
          type="submit"
          part="submit"
          class="btn btn-primary"
          data-testid="login-submit"
          ?disabled=${this.pending}
        >
          ${this.pending ? 'Signing in...' : html`<slot name="submit-label">Sign In</slot>`}
        </button>
      </form>
    `
  }
}
